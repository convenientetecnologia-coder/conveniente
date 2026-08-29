# Sentinela independente da árvore cmd -> node -> workers -> chrome.
# Modos:
#   Install   usa SYSTEM quando elevado; sem elevação usa tarefa do usuário
#             logado. WER/auditoria global ficam explicitamente indisponíveis.
#   Status    retorna estado sem alterar nada
#   Run       loop da tarefa SYSTEM
#   Uninstall remove somente esta tarefa (não remove evidências)
param(
    [ValidateSet('Install','Status','Run','Uninstall')]
    [string]$Mode = 'Status',
    [int]$MaxRuntimeSec = 0
)

$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'ConvenienteForensicSentinel'
$Repo = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Repo 'dados'
$EvidenceDir = Join-Path $DataDir 'forensic_process'
$ForensicRoot = Join-Path $env:ProgramData 'ConvenienteForensics'
$DumpDir = Join-Path $ForensicRoot 'wer'
$EventLog = Join-Path $DataDir 'process_sentinel.jsonl'
$StatePath = Join-Path $DataDir 'process_sentinel_state.json'
$IncidentPath = Join-Path $DataDir 'process_sentinel_last_incident.json'
$InstallPath = Join-Path $DataDir 'process_sentinel_install.json'
$HeartbeatPath = Join-Path $DataDir 'index_heartbeat.json'
$BootContextPath = Join-Path $DataDir 'index_boot_context.json'
$DeepScript = Join-Path $PSScriptRoot 'windowsForensicDeep.ps1'
$MaxLogBytes = 20MB

function Clip-Text([object]$Value, [int]$Max = 500) {
    if ($null -eq $Value) { return $null }
    $s = [string]$Value
    if ($s.Length -le $Max) { return $s }
    return $s.Substring(0, $Max)
}

function Redact-Text([object]$Value, [int]$Max = 500) {
    if ($null -eq $Value) { return $null }
    $s = [string]$Value
    $s = $s -replace '(?i)(--token|--tunnel-token)\s+\S+', '$1 ***'
    $s = $s -replace '(?i)(password|passwd|pwd|secret|token|authorization|cookie)(\s*[:=]\s*)[^\s,;]+', '$1$2***'
    $s = $s -replace '(?i)Bearer\s+[A-Za-z0-9._~+/-]+=*', 'Bearer ***'
    $s = $s -replace '(?i)\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b', '***'
    return (Clip-Text $s $Max)
}

function Ensure-Dirs {
    foreach ($dir in @($DataDir, $EvidenceDir, $ForensicRoot, $DumpDir)) {
        try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch {}
    }
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Write-JsonAtomic([string]$Path, [object]$Value, [int]$Depth = 8) {
    try {
        $json = $Value | ConvertTo-Json -Compress -Depth $Depth
        $tmp = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($tmp, $json, $utf8)
        Move-Item -LiteralPath $tmp -Destination $Path -Force
        return $true
    } catch {
        return $false
    }
}

function Rotate-EventLog {
    try {
        if (-not (Test-Path -LiteralPath $EventLog)) { return }
        $item = Get-Item -LiteralPath $EventLog
        if ($item.Length -lt $MaxLogBytes) { return }
        $prev = "$EventLog.prev"
        Remove-Item -LiteralPath $prev -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $EventLog -Destination $prev -Force
    } catch {}
}

function Append-Event([string]$EventName, [hashtable]$Fields = @{}) {
    try {
        Rotate-EventLog
        $row = [ordered]@{
            ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            iso = (Get-Date).ToUniversalTime().ToString('o')
            event = $EventName
            sentinelPid = $PID
            hostname = $env:COMPUTERNAME
        }
        foreach ($key in $Fields.Keys) { $row[$key] = $Fields[$key] }
        $line = ([pscustomobject]$row | ConvertTo-Json -Compress -Depth 7)
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $stream = New-Object System.IO.StreamWriter($EventLog, $true, $utf8)
        try { $stream.WriteLine($line) } finally { $stream.Dispose() }
    } catch {}
}

function Get-ProcessRecord([int]$ProcessId) {
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (-not $p) { return $null }
        $createdUtc = $null
        try { $createdUtc = ([datetime]$p.CreationDate).ToUniversalTime().ToString('o') } catch {}
        return [pscustomobject]@{
            name = [string]$p.Name
            pid = [int]$p.ProcessId
            ppid = [int]$p.ParentProcessId
            sessionId = [int]$p.SessionId
            createdUtc = $createdUtc
            command = Redact-Text $p.CommandLine 700
            executable = Redact-Text $p.ExecutablePath 320
        }
    } catch {
        return $null
    }
}

function Read-JsonSafe([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Add-ProcessAncestors([object]$Record, [int]$FallbackParentPid = 0) {
    if (-not $Record) { return $null }
    $ancestors = @()
    $parentPid = [int]$Record.ppid
    if ($parentPid -le 0) { $parentPid = $FallbackParentPid }
    for ($depth = 0; $depth -lt 4 -and $parentPid -gt 0; $depth++) {
        $parent = Get-ProcessRecord $parentPid
        if (-not $parent) { break }
        $ancestors += $parent
        $parentPid = [int]$parent.ppid
    }
    $Record | Add-Member -NotePropertyName ancestors -NotePropertyValue $ancestors -Force
    return $Record
}

function Get-MasterFromBootEvidence {
    $boot = Read-JsonSafe $BootContextPath
    $heartbeat = Read-JsonSafe $HeartbeatPath
    $candidateIds = @()
    if ($boot -and [int]$boot.pid -gt 0) { $candidateIds += [int]$boot.pid }
    if ($heartbeat -and [int]$heartbeat.pid -gt 0) { $candidateIds += [int]$heartbeat.pid }
    foreach ($candidatePid in @($candidateIds | Select-Object -Unique)) {
        try {
            $process = Get-Process -Id $candidatePid -ErrorAction Stop
            if ([string]$process.ProcessName -ine 'node') { continue }

            $creationMatches = $false
            if ($boot -and [int]$boot.pid -eq $candidatePid -and [int64]$boot.ts -gt 0) {
                try {
                    $createdMs = [DateTimeOffset]$process.StartTime.ToUniversalTime()
                    $createdEpochMs = $createdMs.ToUnixTimeMilliseconds()
                    $creationMatches = [math]::Abs($createdEpochMs - [int64]$boot.ts) -le 120000
                } catch {}
            }
            $heartbeatFresh = $false
            if ($heartbeat -and [int]$heartbeat.pid -eq $candidatePid -and [int64]$heartbeat.ts -gt 0) {
                $ageMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$heartbeat.ts
                $heartbeatFresh = ($ageMs -ge 0 -and $ageMs -le 90000)
            }
            if (-not $creationMatches -and -not $heartbeatFresh) { continue }

            $record = Get-ProcessRecord $candidatePid
            if (-not $record) {
                $createdUtc = $null
                $executable = $null
                try { $createdUtc = $process.StartTime.ToUniversalTime().ToString('o') } catch {}
                try { $executable = Redact-Text $process.Path 320 } catch {}
                $record = [pscustomobject]@{
                    name = 'node.exe'
                    pid = $candidatePid
                    ppid = if ($boot -and [int]$boot.pid -eq $candidatePid) { [int]$boot.ppid } else { 0 }
                    sessionId = [int]$process.SessionId
                    createdUtc = $createdUtc
                    command = $null
                    executable = $executable
                }
            }
            $record | Add-Member -NotePropertyName evidence -NotePropertyValue 'boot_context_or_heartbeat' -Force
            $fallbackParent = if ($boot -and [int]$boot.pid -eq $candidatePid) { [int]$boot.ppid } else { 0 }
            return (Add-ProcessAncestors $record $fallbackParent)
        } catch {}
    }
    return $null
}

function Find-Master {
    try {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
            $cmd = [string]$p.CommandLine
            if ($cmd -match '(?i)[\\/]conveniente[\\/]index\.js(?:["\s]|$)') {
                $record = Get-ProcessRecord ([int]$p.ProcessId)
                if ($record) {
                    $record | Add-Member -NotePropertyName evidence -NotePropertyValue 'command_line' -Force
                    return (Add-ProcessAncestors $record)
                }
            }
        }
    } catch {}
    return (Get-MasterFromBootEvidence)
}

function Get-MemorySnapshot {
    try {
        $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
        $s = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
        $page = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object {
            [pscustomobject]@{
                name = [string]$_.Name
                allocatedMB = [int]$_.AllocatedBaseSize
                currentUsageMB = [int]$_.CurrentUsage
                peakUsageMB = [int]$_.PeakUsage
            }
        })
        return [pscustomobject]@{
            availableMB = [int]$m.AvailableMBytes
            committedMB = [math]::Round(([double]$m.CommittedBytes / 1MB), 1)
            commitLimitMB = [math]::Round(([double]$m.CommitLimit / 1MB), 1)
            commitUsedPercent = if ([double]$m.CommitLimit -gt 0) {
                [math]::Round(([double]$m.CommittedBytes * 100 / [double]$m.CommitLimit), 1)
            } else { $null }
            poolPagedMB = [math]::Round(([double]$m.PoolPagedBytes / 1MB), 1)
            poolNonpagedMB = [math]::Round(([double]$m.PoolNonpagedBytes / 1MB), 1)
            pagesPerSec = [int64]$m.PagesPersec
            processes = [int]$s.Processes
            threads = [int]$s.Threads
            pageFiles = $page
        }
    } catch {
        return $null
    }
}

function Get-ProcessCounts {
    try {
        $rows = @(Get-Process -ErrorAction SilentlyContinue)
        $names = @('node','cmd','chrome','cloudflared','powershell','taskkill','dwm','WerFault')
        $out = [ordered]@{}
        foreach ($name in $names) {
            $hits = @($rows | Where-Object { $_.ProcessName -ieq $name })
            $out[$name] = [pscustomobject]@{
                count = $hits.Count
                workingSetMB = [math]::Round((($hits | Measure-Object WorkingSet64 -Sum).Sum / 1MB), 1)
                privateMB = [math]::Round((($hits | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB), 1)
                handles = [int64](($hits | Measure-Object HandleCount -Sum).Sum)
            }
        }
        return [pscustomobject]$out
    } catch {
        return $null
    }
}

function Configure-ForensicEventChannels([bool]$IsAdmin) {
    $channels = @(
        @{ name = 'Microsoft-Windows-TaskScheduler/Operational'; size = 33554432 },
        @{ name = 'Microsoft-Windows-Windows Defender/Operational'; size = 33554432 },
        @{ name = 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'; size = 16777216 },
        @{ name = 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational'; size = 16777216 },
        @{ name = 'Microsoft-Windows-Resource-Exhaustion-Detector/Operational'; size = 16777216 },
        @{ name = 'Microsoft-Windows-CodeIntegrity/Operational'; size = 16777216 },
        @{ name = 'Microsoft-Windows-Ntfs/Operational'; size = 33554432 },
        @{ name = 'Microsoft-Windows-Storage-Storport/Operational'; size = 33554432 }
    )
    $results = @()
    $wevtutil = Join-Path $env:SystemRoot 'System32\wevtutil.exe'
    foreach ($channel in $channels) {
        $row = [ordered]@{ name = $channel.name; size = [int64]$channel.size; ok = $false }
        if (-not $IsAdmin) {
            $row.skipped = $true
            $row.error = 'requires_admin'
            $results += [pscustomobject]$row
            continue
        }
        try {
            $probe = & $wevtutil gl $channel.name 2>&1
            if ($LASTEXITCODE -ne 0) {
                $row.error = 'channel_not_available'
            } else {
                & $wevtutil sl $channel.name /e:true "/ms:$($channel.size)" 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) { $row.ok = $true }
                else { $row.error = "wevtutil_exit_$LASTEXITCODE" }
            }
        } catch {
            $row.error = Redact-Text $_.Exception.Message 240
        }
        $results += [pscustomobject]$row
    }
    return @($results)
}

function Configure-SessionAudit([bool]$IsAdmin) {
    # Somente logon/logoff; não habilita command line/process creation global.
    $subcategories = @(
        '{0CCE9215-69AE-11D9-BED3-505054503030}',
        '{0CCE9216-69AE-11D9-BED3-505054503030}',
        '{0CCE921C-69AE-11D9-BED3-505054503030}'
    )
    $auditpol = Join-Path $env:SystemRoot 'System32\auditpol.exe'
    $results = @()
    foreach ($guid in $subcategories) {
        $row = [ordered]@{ subcategory = $guid; ok = $false }
        if (-not $IsAdmin) {
            $row.skipped = $true
            $row.error = 'requires_admin'
            $results += [pscustomobject]$row
            continue
        }
        try {
            & $auditpol /set "/subcategory:$guid" /success:enable 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $row.ok = $true }
            else { $row.error = "auditpol_exit_$LASTEXITCODE" }
        } catch {
            $row.error = Redact-Text $_.Exception.Message 240
        }
        $results += [pscustomobject]$row
    }
    return @($results)
}

function Configure-WerDumps([bool]$IsAdmin) {
    Ensure-Dirs
    if (-not $IsAdmin) {
        return [pscustomobject]@{
            ok = $false
            skipped = $true
            reason = 'requires_admin'
            keys = @()
            service = [pscustomobject]@{ changed = $false; skipped = $true; reason = 'requires_admin' }
        }
    }
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe'
    )
    $results = @()
    foreach ($key in $keys) {
        $row = [ordered]@{ path = $key; ok = $false }
        try {
            New-Item -Path $key -Force -ErrorAction Stop | Out-Null
            New-ItemProperty -Path $key -Name DumpFolder -Value $DumpDir -PropertyType ExpandString -Force -ErrorAction Stop | Out-Null
            New-ItemProperty -Path $key -Name DumpCount -Value 8 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
            New-ItemProperty -Path $key -Name DumpType -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
            $actual = Get-ItemProperty -Path $key -ErrorAction Stop
            $row.dumpFolder = [string]$actual.DumpFolder
            $row.dumpCount = [int]$actual.DumpCount
            $row.dumpType = [int]$actual.DumpType
            $row.ok = (
                $row.dumpFolder -eq $DumpDir -and
                $row.dumpCount -eq 8 -and
                $row.dumpType -eq 1
            )
            if (-not $row.ok) { $row.error = 'registry_verification_failed' }
        } catch {
            $row.error = Redact-Text $_.Exception.Message 260
        }
        $results += [pscustomobject]$row
    }
    $service = [ordered]@{ changed = $false }
    try {
        $svc = Get-CimInstance Win32_Service -Filter "Name='WerSvc'"
        $service.beforeState = [string]$svc.State
        $service.beforeStartMode = [string]$svc.StartMode
        if ([string]$svc.StartMode -eq 'Disabled') {
            Set-Service -Name WerSvc -StartupType Manual -ErrorAction Stop
            $service.changed = $true
        }
        $svc2 = Get-CimInstance Win32_Service -Filter "Name='WerSvc'"
        $service.afterState = [string]$svc2.State
        $service.afterStartMode = [string]$svc2.StartMode
    } catch {
        $service.error = Redact-Text $_.Exception.Message 260
    }
    return [pscustomobject]@{
        ok = @($results | Where-Object { $_.ok -ne $true }).Count -eq 0
        skipped = $false
        keys = $results
        service = [pscustomobject]$service
    }
}

function Get-SentinelStatus {
    $task = $null
    try {
        if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
            $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($t) {
                $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
                $task = [pscustomobject]@{
                    exists = $true
                    state = [string]$t.State
                    userId = [string]$t.Principal.UserId
                    logonType = [string]$t.Principal.LogonType
                    lastRunUtc = if ($info -and $info.LastRunTime.Year -gt 1900) { $info.LastRunTime.ToUniversalTime().ToString('o') } else { $null }
                    lastResult = if ($info) { [int64]$info.LastTaskResult } else { $null }
                }
            }
        }
    } catch {}
    if (-not $task) { $task = [pscustomobject]@{ exists = $false } }
    $state = $null
    try {
        if (Test-Path -LiteralPath $StatePath) {
            $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        }
    } catch {}
    return [pscustomobject]@{
        ok = $true
        mode = 'status'
        taskName = $TaskName
        task = $task
        state = $state
        eventLog = $EventLog
        incident = $IncidentPath
        dumpDir = $DumpDir
    }
}

function Install-Sentinel {
    Ensure-Dirs
    $isAdmin = Test-IsAdministrator
    $eventChannels = Configure-ForensicEventChannels $isAdmin
    $sessionAudit = Configure-SessionAudit $isAdmin
    $wer = Configure-WerDumps $isAdmin
    $taskMode = if ($isAdmin) { 'system_startup' } else { 'current_user_logon' }
    $taskResult = [ordered]@{
        ok = $false
        taskName = $TaskName
        mode = $taskMode
        isAdmin = $isAdmin
    }
    try {
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $args = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode Run"
        if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
            throw 'scheduled_tasks_module_unavailable'
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        $action = New-ScheduledTaskAction -Execute $psExe -Argument $args -WorkingDirectory $Repo -ErrorAction Stop
        if ($isAdmin) {
            $trigger = New-ScheduledTaskTrigger -AtStartup -ErrorAction Stop
            $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        } else {
            $identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            if (-not $identityName) { throw 'current_user_identity_missing' }
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identityName -ErrorAction Stop
            $principal = New-ScheduledTaskPrincipal -UserId $identityName -LogonType Interactive -RunLevel Limited
        }
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -MultipleInstances IgnoreNew `
            -StartWhenAvailable `
            -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $action `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -Force `
            -ErrorAction Stop | Out-Null
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop

        $verified = $null
        for ($attempt = 0; $attempt -lt 24; $attempt++) {
            Start-Sleep -Milliseconds 250
            $verified = Get-SentinelStatus
            $running = (
                $verified.task -and
                $verified.task.exists -eq $true -and
                [string]$verified.task.state -eq 'Running'
            )
            if ($running -and $verified.state) { break }
        }
        $taskResult.registered = [bool]($verified.task -and $verified.task.exists -eq $true)
        $taskResult.running = [bool](
            $verified.task -and
            [string]$verified.task.state -eq 'Running'
        )
        $taskResult.stateAlive = [bool]$verified.state
        $taskResult.ok = (
            $taskResult.registered -and
            $taskResult.running -and
            $taskResult.stateAlive
        )
        if (-not $taskResult.ok) {
            throw "sentinel_verification_failed:registered=$($taskResult.registered),running=$($taskResult.running),state=$($taskResult.stateAlive)"
        }
    } catch {
        $taskResult.error = Redact-Text $_.Exception.Message 300
    }
    $status = Get-SentinelStatus
    $result = [ordered]@{
        ok = [bool]$taskResult.ok
        mode = 'install'
        installedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        task = [pscustomobject]$taskResult
        eventChannels = $eventChannels
        sessionAudit = $sessionAudit
        wer = $wer
        capabilities = [pscustomobject]@{
            processTrace = [bool]$taskResult.ok
            memorySnapshots = [bool]$taskResult.ok
            survivesNodeOrCmdExit = [bool]$taskResult.ok
            survivesUserLogoff = [bool]($taskResult.ok -and $isAdmin)
            systemEventConfiguration = $isAdmin
            werLocalDumps = [bool]($isAdmin -and $wer.ok)
        }
        status = $status
    }
    Write-JsonAtomic $InstallPath ([pscustomobject]$result) 8 | Out-Null
    return [pscustomobject]$result
}

function Uninstall-Sentinel {
    $result = [ordered]@{ ok = $false; mode = 'uninstall'; taskName = $TaskName }
    try {
        if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        } else {
            & schtasks.exe /End /TN $TaskName 2>$null | Out-Null
            & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
        }
        $result.ok = $true
    } catch {
        $result.error = Redact-Text $_.Exception.Message 260
    }
    return [pscustomobject]$result
}

function Add-RingEvent([System.Collections.ArrayList]$Ring, [object]$Row) {
    try {
        [void]$Ring.Add($Row)
        while ($Ring.Count -gt 240) { $Ring.RemoveAt(0) }
    } catch {}
}

function Drain-TraceEvents {
    param(
        [hashtable]$Known,
        [System.Collections.ArrayList]$Ring
    )
    foreach ($source in @('ConvenienteProcStart', 'ConvenienteProcStop')) {
        foreach ($evt in @(Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)) {
            try {
                $n = $evt.SourceEventArgs.NewEvent
                $name = [string]$n.ProcessName
                $pidValue = [int]$n.ProcessID
                $kind = if ($source -eq 'ConvenienteProcStart') { 'process_start' } else { 'process_stop' }
                $traceTimeUtc = $null
                try { $traceTimeUtc = [DateTime]::FromFileTimeUtc([int64]$n.TIME_CREATED).ToString('o') } catch {}
                $knownRow = $null
                if ($kind -eq 'process_start') {
                    Start-Sleep -Milliseconds 20
                    $knownRow = Get-ProcessRecord $pidValue
                    if (-not $knownRow) {
                        $knownRow = [pscustomobject]@{
                            name = $name
                            pid = $pidValue
                            ppid = [int]$n.ParentProcessID
                            sessionId = [int]$n.SessionID
                            command = $null
                        }
                    }
                    $Known[[string]$pidValue] = $knownRow
                } else {
                    if ($Known.ContainsKey([string]$pidValue)) {
                        $knownRow = $Known[[string]$pidValue]
                        $Known.Remove([string]$pidValue)
                    }
                }
                $command = if ($knownRow) { [string]$knownRow.command } else { '' }
                $logThis = $name -match '(?i)^(node|cmd|taskkill|procdump|werfault)\.exe$'
                if (-not $logThis -and $name -match '(?i)^powershell\.exe$') {
                    $logThis = $command -match '(?i)conveniente|auto_vigia|taskkill|stop-process|shutdown|restart|forensic|diskclean|standby'
                }
                if ($logThis) {
                    $fields = @{
                        name = $name
                        pid = $pidValue
                        ppid = [int]$n.ParentProcessID
                        sessionId = [int]$n.SessionID
                        traceTimeUtc = $traceTimeUtc
                        command = Redact-Text $command 700
                    }
                    if ($kind -eq 'process_stop') {
                        $fields.exitStatus = [uint32]$n.ExitStatus
                        $fields.exitHex = ('0x{0:X8}' -f ([uint32]$n.ExitStatus))
                    }
                    $row = [pscustomobject]([ordered]@{
                        ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                        iso = (Get-Date).ToUniversalTime().ToString('o')
                        traceTimeUtc = $fields.traceTimeUtc
                        event = $kind
                        name = $fields.name
                        pid = $fields.pid
                        ppid = $fields.ppid
                        sessionId = $fields.sessionId
                        command = $fields.command
                        exitStatus = $fields.exitStatus
                        exitHex = $fields.exitHex
                    })
                    Append-Event $kind $fields
                    Add-RingEvent $Ring $row
                }
            } catch {}
            try { Remove-Event -EventIdentifier $evt.EventIdentifier -ErrorAction SilentlyContinue } catch {}
        }
    }
}

function Capture-Incident {
    param(
        [object]$LastMaster,
        [System.Collections.ArrayList]$Ring
    )
    $observed = (Get-Date).ToUniversalTime().ToString('o')
    Append-Event 'master_disappeared' @{
        lastMaster = $LastMaster
        memory = Get-MemorySnapshot
        counts = Get-ProcessCounts
    }

    $deepOk = $false
    $deepError = $null
    try {
        if (Test-Path -LiteralPath $DeepScript) {
            & $DeepScript -Hours 12 -MaxEvents 180 -Reason 'sentinel_master_disappeared' | Out-Null
            $deepOk = Test-Path -LiteralPath (Join-Path $DataDir 'windows_forensic_deep_last.json')
        } else {
            $deepError = 'deep_script_missing'
        }
    } catch {
        $deepError = Redact-Text $_.Exception.Message 300
    }

    $incident = [ordered]@{
        ok = $true
        kind = 'master_disappeared'
        observedAtUtc = $observed
        hostname = $env:COMPUTERNAME
        sentinelPid = $PID
        lastMaster = $LastMaster
        currentMaster = Find-Master
        memory = Get-MemorySnapshot
        counts = Get-ProcessCounts
        recentProcessEvents = @($Ring | Select-Object -Last 240)
        deepCaptureOk = $deepOk
        deepCaptureError = $deepError
        deepReportPath = (Join-Path $DataDir 'windows_forensic_deep_last.json')
    }
    Write-JsonAtomic $IncidentPath ([pscustomobject]$incident) 9 | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss_fff')
    Write-JsonAtomic (Join-Path $EvidenceDir "incident_$stamp.json") ([pscustomobject]$incident) 9 | Out-Null
}

function Run-Sentinel {
    Ensure-Dirs
    $runStarted = Get-Date
    $mutex = $null
    $hasMutex = $false
    try {
        $created = $false
        $mutex = New-Object System.Threading.Mutex($false, 'Global\ConvenienteForensicSentinel', [ref]$created)
        $hasMutex = $mutex.WaitOne(0, $false)
    } catch {}
    if (-not $hasMutex) {
        Append-Event 'sentinel_duplicate_exit' @{}
        return
    }

    $known = @{}
    $ring = New-Object System.Collections.ArrayList
    try {
        Register-WmiEvent -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName='node.exe' OR ProcessName='cmd.exe' OR ProcessName='powershell.exe' OR ProcessName='taskkill.exe' OR ProcessName='procdump.exe' OR ProcessName='WerFault.exe'" -SourceIdentifier 'ConvenienteProcStart' | Out-Null
        Register-WmiEvent -Query "SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName='node.exe' OR ProcessName='cmd.exe' OR ProcessName='powershell.exe' OR ProcessName='taskkill.exe' OR ProcessName='procdump.exe' OR ProcessName='WerFault.exe'" -SourceIdentifier 'ConvenienteProcStop' | Out-Null
    } catch {
        Append-Event 'sentinel_wmi_subscribe_error' @{ error = Redact-Text $_.Exception.Message 300 }
    }

    $lastMaster = Find-Master
    if ($lastMaster) { Append-Event 'master_seen' @{ master = $lastMaster } }
    $runIsAdmin = Test-IsAdministrator
    Append-Event 'sentinel_boot' @{
        mode = if ($runIsAdmin) { 'SYSTEM_task' } else { 'current_user_task' }
        identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        isAdmin = $runIsAdmin
        master = $lastMaster
        memory = Get-MemorySnapshot
        counts = Get-ProcessCounts
    }

    $nextPoll = Get-Date
    $nextState = Get-Date
    try {
        while ($true) {
            if ($MaxRuntimeSec -gt 0 -and ((Get-Date) - $runStarted).TotalSeconds -ge $MaxRuntimeSec) {
                Append-Event 'sentinel_bounded_run_complete' @{ maxRuntimeSec = $MaxRuntimeSec }
                break
            }
            Drain-TraceEvents -Known $known -Ring $ring
            $now = Get-Date
            if ($now -ge $nextPoll) {
                $currentMaster = Find-Master
                if ($lastMaster -and -not $currentMaster) {
                    Start-Sleep -Milliseconds 800
                    Drain-TraceEvents -Known $known -Ring $ring
                    Capture-Incident -LastMaster $lastMaster -Ring $ring
                    $lastMaster = $null
                } elseif ($currentMaster -and (-not $lastMaster -or [int]$lastMaster.pid -ne [int]$currentMaster.pid)) {
                    Append-Event 'master_seen' @{ master = $currentMaster }
                    $lastMaster = $currentMaster
                } elseif ($currentMaster) {
                    $lastMaster = $currentMaster
                }
                $nextPoll = $now.AddSeconds(2)
            }
            if ($now -ge $nextState) {
                $state = [ordered]@{
                    ok = $true
                    updatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
                    sentinelPid = $PID
                    hostname = $env:COMPUTERNAME
                    mode = if ($runIsAdmin) { 'SYSTEM_task' } else { 'current_user_task' }
                    isAdmin = $runIsAdmin
                    master = $lastMaster
                    memory = Get-MemorySnapshot
                    counts = Get-ProcessCounts
                    recentEvents = @($ring | Select-Object -Last 40)
                }
                Write-JsonAtomic $StatePath ([pscustomobject]$state) 8 | Out-Null
                $nextState = $now.AddSeconds(10)
            }
            Start-Sleep -Milliseconds 350
        }
    } finally {
        foreach ($id in @('ConvenienteProcStart','ConvenienteProcStop')) {
            try { Unregister-Event -SourceIdentifier $id -Force -ErrorAction SilentlyContinue } catch {}
        }
        try { if ($hasMutex) { $mutex.ReleaseMutex() } } catch {}
        try { if ($mutex) { $mutex.Dispose() } } catch {}
    }
}

switch ($Mode) {
    'Install' {
        $result = Install-Sentinel
        Write-Output ($result | ConvertTo-Json -Compress -Depth 9)
    }
    'Status' {
        $result = Get-SentinelStatus
        Write-Output ($result | ConvertTo-Json -Compress -Depth 9)
    }
    'Uninstall' {
        $result = Uninstall-Sentinel
        Write-Output ($result | ConvertTo-Json -Compress -Depth 6)
    }
    'Run' {
        Run-Sentinel
    }
}
