# Leitura so-Event Viewer + porteiro. Sem Security. Sem senha. Sem matar processo.
param(
    [int]$Hours = 24,
    [int]$Max = 80
)

$ErrorActionPreference = 'SilentlyContinue'
if ($Hours -lt 1) { $Hours = 1 }
if ($Hours -gt 72) { $Hours = 72 }
if ($Max -lt 10) { $Max = 10 }
if ($Max -gt 120) { $Max = 120 }

$since = (Get-Date).AddHours(-$Hours)
$out = New-Object System.Collections.Generic.List[object]

function Clip-Text([string]$s, [int]$n) {
    if (-not $s) { return '' }
    if ($s.Length -le $n) { return $s }
    return $s.Substring(0, $n)
}

function Clip-Cmd([string]$s) {
    if (-not $s) { return '' }
    $s = $s -replace '(?i)(--token|--tunnel-token)\s+\S+', '$1 ***'
    $s = $s -replace '(?i)(eyJ[A-Za-z0-9_-]{8,})', '***'
    return (Clip-Text $s 180)
}

function Add-Ev($ev, [string]$bag) {
    if (-not $ev) { return }
    $out.Add([pscustomobject]@{
        bag      = $bag
        time     = $ev.TimeCreated.ToString('o')
        id       = [int]$ev.Id
        level    = [string]$ev.LevelDisplayName
        log      = [string]$ev.LogName
        provider = [string]$ev.ProviderName
        message  = (Clip-Text ([string]$ev.Message) 280)
    }) | Out-Null
}

function Pull([string]$LogName, $Ids, [string]$bag) {
    try {
        $ht = @{ LogName = $LogName; StartTime = $since }
        if ($Ids) { $ht.Id = $Ids }
        Get-WinEvent -FilterHashtable $ht -MaxEvents $Max -ErrorAction SilentlyContinue | ForEach-Object {
            Add-Ev $_ $bag
        }
    } catch {}
}

Pull 'Application' @(1000, 1001, 1002) 'app_crash_hang'
Pull 'System' @(41, 1074, 6005, 6006, 6008, 6009) 'power_shutdown'
Pull 'System' @(7000, 7023, 7031, 7034) 'service'

$boot = $null
$uptimeMin = $null
try {
    $os = Get-CimInstance Win32_OperatingSystem
    if ($os) {
        $boot = $os.LastBootUpTime.ToUniversalTime().ToString('o')
        $uptimeMin = [int](((Get-Date) - $os.LastBootUpTime).TotalMinutes)
    }
} catch {}

$sorted = @($out | Sort-Object time -Descending | Select-Object -First $Max)
$nodeish = @($sorted | Where-Object {
    $t = ('' + $_.provider + ' ' + $_.message)
    $t -match '(?i)node\.exe|cmd\.exe|conveniente|powershell|Application Error|Windows Error Reporting'
})

$counts = [pscustomobject]@{
    node = 0; cmd = 0; chrome = 0; cloudflared = 0; powershell = 0
    chromeWsMB = 0; nodeWsMB = 0
}
$detail = @()
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        $name = [string]$_.Name
        if ($name -notmatch '(?i)^(node|cmd|chrome|chromium|cloudflared|powershell)\.exe$') { return }
        $ws = [int](($_.WorkingSetSize / 1MB))
        if ($name -match '(?i)^chrome') { $counts.chrome++; $counts.chromeWsMB += $ws; return }
        if ($name -match '(?i)^node') { $counts.node++; $counts.nodeWsMB += $ws }
        elseif ($name -match '(?i)^cmd') { $counts.cmd++ }
        elseif ($name -match '(?i)^cloudflared') { $counts.cloudflared++ }
        elseif ($name -match '(?i)^powershell') { $counts.powershell++ }
        $started = $null
        if ($_.CreationDate) {
            try { $started = ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } catch {}
        }
        $detail += [pscustomobject]@{
            name    = $name
            pid     = [int]$_.ProcessId
            ppid    = [int]$_.ParentProcessId
            wsMB    = $ws
            started = $started
            cmd     = (Clip-Cmd ([string]$_.CommandLine))
        }
    }
} catch {}

function Lines-Of([string]$p, [int]$n) {
    if (-not (Test-Path -LiteralPath $p)) { return @() }
    try {
        $raw = Get-Content -LiteralPath $p -Tail $n -ErrorAction SilentlyContinue
        $arr = @()
        foreach ($line in @($raw)) { $arr += [string]$line }
        return $arr
    } catch {
        return @()
    }
}

$porteiro = @()
foreach ($pp in @(
    'C:\auto_vigia\logs\porteiro.log',
    'C:\auto_vigia\porteiro.log',
    'C:\auto_vigia_markson\logs\porteiro.log'
)) {
    if (-not (Test-Path -LiteralPath $pp)) { continue }
    $st = Get-Item -LiteralPath $pp -ErrorAction SilentlyContinue
    $tail = Lines-Of $pp 220
    $hits = @($tail | Where-Object { $_ -match '(?i)MANUAL|AUTO|killed|reboot|down_wait|start done|PARADO|AUTO_BOOT' })
    $porteiro += [pscustomobject]@{
        path     = $pp
        exists   = $true
        size     = if ($st) { [int64]$st.Length } else { $null }
        mtimeUtc = if ($st) { $st.LastWriteTimeUtc.ToString('o') } else { $null }
        hits     = @($hits | Select-Object -Last 40)
        tail     = @($tail | Select-Object -Last 30)
    }
}

[pscustomobject]@{
    ok           = $true
    collectedAt  = (Get-Date).ToUniversalTime().ToString('o')
    hostname     = $env:COMPUTERNAME
    hours        = $Hours
    lastBootUtc  = $boot
    uptimeMin    = $uptimeMin
    total        = @($sorted).Count
    nodeishCount = @($nodeish).Count
    events       = @($sorted)
    nodeish      = @($nodeish)
    counts       = $counts
    processes    = @($detail | Select-Object -First 40)
    porteiro     = @($porteiro)
} | ConvertTo-Json -Compress -Depth 5
