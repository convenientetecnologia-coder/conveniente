# Leitura so-Event Viewer. Sem Security. Sem senha. Sem matar processo.
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

function Add-Ev($ev, [string]$bag) {
    if (-not $ev) { return }
    $msg = [string]$ev.Message
    if ($msg.Length -gt 700) { $msg = $msg.Substring(0, 700) }
    $out.Add([pscustomobject]@{
        bag          = $bag
        time         = $ev.TimeCreated.ToString('o')
        id           = [int]$ev.Id
        level        = [string]$ev.LevelDisplayName
        log          = [string]$ev.LogName
        provider     = [string]$ev.ProviderName
        message      = $msg
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
Pull 'System' @(41, 1074, 6006, 6008) 'power_shutdown'
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

$sorted = $out | Sort-Object time -Descending | Select-Object -First $Max
$nodeish = @($sorted | Where-Object {
    $t = ('' + $_.provider + ' ' + $_.message)
    $t -match '(?i)node\.exe|cmd\.exe|conveniente|powershell|Application Error|Windows Error Reporting'
})

$procs = @()
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '(?i)^(node|cmd|chrome|chromium|cloudflared|powershell)\.exe$' } |
        Select-Object -First 80 |
        ForEach-Object {
            $cl = [string]$_.CommandLine
            if ($cl.Length -gt 220) { $cl = $cl.Substring(0, 220) }
            $procs += [pscustomobject]@{
                name     = [string]$_.Name
                pid      = [int]$_.ProcessId
                ppid     = [int]$_.ParentProcessId
                wsMB     = [int](($_.WorkingSetSize / 1MB))
                started  = if ($_.CreationDate) { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o') } else { $null }
                cmd      = $cl
            }
        }
} catch {}

function Tail-Text([string]$p, [int]$n) {
    if (-not $p) { return $null }
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try {
        $lines = Get-Content -LiteralPath $p -Tail $n -ErrorAction SilentlyContinue
        return @($lines)
    } catch {
        return $null
    }
}

$porteiroPaths = @(
    'C:\auto_vigia\logs\porteiro.log',
    'C:\auto_vigia\porteiro.log',
    'C:\auto_vigia_markson\logs\porteiro.log'
)
$porteiro = @()
foreach ($pp in $porteiroPaths) {
    $tail = Tail-Text $pp 80
    if ($null -ne $tail) {
        $st = Get-Item -LiteralPath $pp -ErrorAction SilentlyContinue
        $porteiro += [pscustomobject]@{
            path     = $pp
            exists   = $true
            size     = if ($st) { [int64]$st.Length } else { $null }
            mtimeUtc = if ($st) { $st.LastWriteTimeUtc.ToString('o') } else { $null }
            tail     = $tail
        }
    }
}

[pscustomobject]@{
    ok            = $true
    collectedAt   = (Get-Date).ToUniversalTime().ToString('o')
    hostname      = $env:COMPUTERNAME
    hours         = $Hours
    lastBootUtc   = $boot
    uptimeMin     = $uptimeMin
    total         = @($sorted).Count
    nodeishCount  = @($nodeish).Count
    events        = @($sorted)
    nodeish       = @($nodeish)
    processes     = @($procs)
    porteiro      = @($porteiro)
} | ConvertTo-Json -Compress -Depth 6
