# Coleta forense profunda, somente leitura.
# Não mata processo, não abre navegador, não altera configuração do Windows.
param(
    [int]$Hours = 24,
    [int]$MaxEvents = 100,
    [string]$Reason = 'manual'
)

$ErrorActionPreference = 'SilentlyContinue'
$Hours = [math]::Max(1, [math]::Min(168, $Hours))
$MaxEvents = [math]::Max(20, [math]::Min(250, $MaxEvents))
$Since = (Get-Date).AddHours(-$Hours)
$Repo = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Repo 'dados'
$LastPath = Join-Path $DataDir 'windows_forensic_deep_last.json'

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

function To-Iso([object]$Value) {
    if ($null -eq $Value) { return $null }
    try { return ([datetime]$Value).ToUniversalTime().ToString('o') } catch { return (Clip-Text $Value 80) }
}

function To-MB([object]$Value) {
    try { return [math]::Round(([double]$Value / 1MB), 1) } catch { return $null }
}

function Get-EventRows {
    param(
        [string]$LogName,
        [int[]]$Ids = @(),
        [string]$Bag = 'event',
        [string]$ProviderRegex = '',
        [string]$MessageRegex = '',
        [int]$Limit = 100
    )
    $rows = @()
    try {
        $filter = @{ LogName = $LogName; StartTime = $Since }
        if ($Ids -and $Ids.Count -gt 0) { $filter.Id = $Ids }
        $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents ([math]::Max($Limit * 3, $Limit)) -ErrorAction SilentlyContinue)
        foreach ($ev in $events) {
            if ($ProviderRegex -and ([string]$ev.ProviderName) -notmatch $ProviderRegex) { continue }
            $message = [string]$ev.Message
            if ($MessageRegex -and $message -notmatch $MessageRegex) { continue }
            $rows += [pscustomobject]@{
                bag      = $Bag
                timeUtc  = if ($ev.TimeCreated) { $ev.TimeCreated.ToUniversalTime().ToString('o') } else { $null }
                id       = [int]$ev.Id
                level    = [string]$ev.LevelDisplayName
                provider = [string]$ev.ProviderName
                message  = (Redact-Text $message 700)
            }
            if ($rows.Count -ge $Limit) { break }
        }
    } catch {}
    return @($rows)
}

function Get-RegistryValueSummary([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $p = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
        if (-not $p) { return $null }
        return [pscustomobject]@{
            path       = $Path
            dumpFolder = Redact-Text $p.DumpFolder 260
            dumpCount  = if ($null -ne $p.DumpCount) { [int]$p.DumpCount } else { $null }
            dumpType   = if ($null -ne $p.DumpType) { [int]$p.DumpType } else { $null }
        }
    } catch { return $null }
}

function Get-FileEvidence([string]$Path) {
    $out = [ordered]@{ path = $Path; exists = $false }
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]$out }
        $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
        $out.exists = $true
        $out.size = [int64]$item.Length
        $out.createdUtc = To-Iso $item.CreationTimeUtc
        $out.modifiedUtc = To-Iso $item.LastWriteTimeUtc
        $out.version = Redact-Text $item.VersionInfo.FileVersion 100
        $out.product = Redact-Text $item.VersionInfo.ProductName 160
        $out.company = Redact-Text $item.VersionInfo.CompanyName 160
        try { $out.sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } catch {}
        try {
            $sig = Get-AuthenticodeSignature -LiteralPath $Path
            $out.signatureStatus = [string]$sig.Status
            $out.signer = if ($sig.SignerCertificate) { Redact-Text $sig.SignerCertificate.Subject 220 } else { $null }
        } catch {}
    } catch {
        $out.error = Redact-Text $_.Exception.Message 220
    }
    return [pscustomobject]$out
}

function Get-DumpInventory {
    $rows = @()
    $dirs = @(
        (Join-Path $DataDir 'forensic_dumps'),
        (Join-Path $DataDir 'forensic_node_reports'),
        (Join-Path $env:LOCALAPPDATA 'CrashDumps')
    ) | Select-Object -Unique
    foreach ($dir in $dirs) {
        try {
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '(?i)node|report\.|\.dmp$' } |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 30 |
                ForEach-Object {
                    $rows += [pscustomobject]@{
                        path = $_.FullName
                        size = [int64]$_.Length
                        modifiedUtc = $_.LastWriteTimeUtc.ToString('o')
                    }
                }
        } catch {}
    }
    return @($rows | Sort-Object modifiedUtc -Descending | Select-Object -First 40)
}

function Get-PorteiroHistory {
    $result = [ordered]@{
        path = $null
        exists = $false
        size = 0
        modifiedUtc = $null
        rows = @()
    }
    foreach ($candidate in @(
        'C:\auto_vigia\logs\porteiro.log',
        'C:\auto_vigia\porteiro.log',
        'C:\auto_vigia_markson\logs\porteiro.log'
    )) {
        try {
            if (-not (Test-Path -LiteralPath $candidate)) { continue }
            $item = Get-Item -LiteralPath $candidate
            $result.path = $candidate
            $result.exists = $true
            $result.size = [int64]$item.Length
            $result.modifiedUtc = $item.LastWriteTimeUtc.ToString('o')
            $lines = @(Get-Content -LiteralPath $candidate -Tail 20000 -ErrorAction SilentlyContinue)
            $hits = @($lines | Where-Object {
                $_ -match '(?i)BOOT|down_wait|AUTO start|AUTO_BOOT|MANUAL start|MANUAL stop|PARADO|mem_soft|reboot|ERROR'
            } | Select-Object -Last 2000)
            $rows = @()
            foreach ($line in $hits) {
                $text = Redact-Text $line 900
                $kind = 'other'
                if ($text -match '(?i)NODE=down_wait') { $kind = 'node_down' }
                elseif ($text -match '(?i)AUTO start done') { $kind = 'auto_start' }
                elseif ($text -match '(?i)AUTO_BOOT') { $kind = 'auto_boot' }
                elseif ($text -match '(?i)MANUAL start') { $kind = 'manual_start' }
                elseif ($text -match '(?i)MANUAL stop|PARADO') { $kind = 'manual_stop' }
                elseif ($text -match '(?i)mem_soft') { $kind = 'mem_soft' }
                elseif ($text -match '(?i)\bBOOT\b') { $kind = 'porteiro_boot' }
                elseif ($text -match '(?i)reboot') { $kind = 'reboot' }
                elseif ($text -match '(?i)ERROR') { $kind = 'error' }
                $localTime = $null
                if ($text -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') { $localTime = $Matches[1] }
                $rows += [pscustomobject]@{
                    localTime = $localTime
                    kind = $kind
                    line = $text
                }
            }
            $result.rows = $rows
            break
        } catch {}
    }
    return [pscustomobject]$result
}

try { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null } catch {}

$identity = [ordered]@{
    hostname = $env:COMPUTERNAME
    user = $env:USERNAME
    processId = $PID
    reason = Redact-Text $Reason 100
    isAdmin = $false
}
try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $identity.isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

$osInfo = $null
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $osInfo = [pscustomobject]@{
        caption = [string]$os.Caption
        version = [string]$os.Version
        build = [string]$os.BuildNumber
        architecture = [string]$os.OSArchitecture
        installUtc = To-Iso $os.InstallDate
        lastBootUtc = To-Iso $os.LastBootUpTime
        uptimeMin = [int](((Get-Date) - $os.LastBootUpTime).TotalMinutes)
        totalVisibleMemoryMB = [math]::Round(([double]$os.TotalVisibleMemorySize / 1024), 1)
        freePhysicalMemoryMB = [math]::Round(([double]$os.FreePhysicalMemory / 1024), 1)
        totalVirtualMemoryMB = [math]::Round(([double]$os.TotalVirtualMemorySize / 1024), 1)
        freeVirtualMemoryMB = [math]::Round(([double]$os.FreeVirtualMemory / 1024), 1)
    }
} catch {}

$computerInfo = $null
try {
    $cs = Get-CimInstance Win32_ComputerSystem
    $computerInfo = [pscustomobject]@{
        manufacturer = Redact-Text $cs.Manufacturer 160
        model = Redact-Text $cs.Model 160
        totalPhysicalMemoryMB = To-MB $cs.TotalPhysicalMemory
        logicalProcessors = [int]$cs.NumberOfLogicalProcessors
        physicalProcessors = [int]$cs.NumberOfProcessors
        domainRole = [int]$cs.DomainRole
    }
} catch {}

$cpu = @()
try {
    $cpu = @(Get-CimInstance Win32_Processor | ForEach-Object {
        [pscustomobject]@{
            name = Redact-Text $_.Name 180
            cores = [int]$_.NumberOfCores
            logical = [int]$_.NumberOfLogicalProcessors
            maxClockMHz = [int]$_.MaxClockSpeed
            loadPercent = if ($null -ne $_.LoadPercentage) { [int]$_.LoadPercentage } else { $null }
        }
    })
} catch {}

$memoryModules = @()
try {
    $memoryModules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
        [pscustomobject]@{
            bank = Redact-Text $_.BankLabel 80
            capacityMB = To-MB $_.Capacity
            speedMHz = if ($null -ne $_.Speed) { [int]$_.Speed } else { $null }
            configuredMHz = if ($null -ne $_.ConfiguredClockSpeed) { [int]$_.ConfiguredClockSpeed } else { $null }
            manufacturer = Redact-Text $_.Manufacturer 100
            partNumber = Redact-Text $_.PartNumber 120
        }
    })
} catch {}

$gpu = @()
try {
    $gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object {
        [pscustomobject]@{
            name = Redact-Text $_.Name 180
            status = [string]$_.Status
            driverVersion = Redact-Text $_.DriverVersion 100
            driverDateUtc = To-Iso $_.DriverDate
            adapterRamMB = To-MB $_.AdapterRAM
            videoProcessor = Redact-Text $_.VideoProcessor 180
            currentResolution = if ($_.CurrentHorizontalResolution -and $_.CurrentVerticalResolution) {
                "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)"
            } else { $null }
        }
    })
} catch {}

$diskDrives = @()
try {
    $diskDrives = @(Get-CimInstance Win32_DiskDrive | ForEach-Object {
        [pscustomobject]@{
            model = Redact-Text $_.Model 180
            interface = [string]$_.InterfaceType
            mediaType = Redact-Text $_.MediaType 100
            status = [string]$_.Status
            sizeGB = if ($_.Size) { [math]::Round(([double]$_.Size / 1GB), 1) } else { $null }
        }
    })
} catch {}

$logicalDisks = @()
try {
    $logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
        [pscustomobject]@{
            device = [string]$_.DeviceID
            fileSystem = [string]$_.FileSystem
            sizeGB = if ($_.Size) { [math]::Round(([double]$_.Size / 1GB), 2) } else { $null }
            freeGB = if ($null -ne $_.FreeSpace) { [math]::Round(([double]$_.FreeSpace / 1GB), 2) } else { $null }
            volume = Redact-Text $_.VolumeName 100
        }
    })
} catch {}

$physicalDiskHealth = @()
try {
    if (Get-Command Get-PhysicalDisk -ErrorAction SilentlyContinue) {
        $physicalDiskHealth = @(Get-PhysicalDisk | ForEach-Object {
            $row = [ordered]@{
                friendlyName = Redact-Text $_.FriendlyName 180
                mediaType = [string]$_.MediaType
                healthStatus = [string]$_.HealthStatus
                operationalStatus = Redact-Text ($_.OperationalStatus -join ',') 140
                sizeGB = if ($_.Size) { [math]::Round(([double]$_.Size / 1GB), 1) } else { $null }
            }
            try {
                $rel = $_ | Get-StorageReliabilityCounter
                $row.temperatureC = $rel.Temperature
                $row.readErrorsTotal = $rel.ReadErrorsTotal
                $row.writeErrorsTotal = $rel.WriteErrorsTotal
                $row.wear = $rel.Wear
            } catch {}
            [pscustomobject]$row
        })
    }
} catch {}

$memoryPerf = $null
try {
    $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $sysPerf = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
    $memoryPerf = [pscustomobject]@{
        availableMB = [int]$m.AvailableMBytes
        committedMB = To-MB $m.CommittedBytes
        commitLimitMB = To-MB $m.CommitLimit
        commitUsedPercent = if ([double]$m.CommitLimit -gt 0) {
            [math]::Round(([double]$m.CommittedBytes * 100 / [double]$m.CommitLimit), 1)
        } else { $null }
        poolPagedMB = To-MB $m.PoolPagedBytes
        poolNonpagedMB = To-MB $m.PoolNonpagedBytes
        cacheMB = To-MB $m.CacheBytes
        pagesPerSec = [int64]$m.PagesPersec
        processes = [int]$sysPerf.Processes
        threads = [int]$sysPerf.Threads
        systemUpTimeSec = [int64]$sysPerf.SystemUpTime
    }
} catch {}

$pageFiles = @()
try {
    $pageFiles = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object {
        [pscustomobject]@{
            name = [string]$_.Name
            allocatedMB = [int]$_.AllocatedBaseSize
            currentUsageMB = [int]$_.CurrentUsage
            peakUsageMB = [int]$_.PeakUsage
            tempPageFile = [bool]$_.TempPageFile
        }
    })
} catch {}

$processSummary = @()
$processDetails = @()
try {
    $allProcesses = @(Get-Process -ErrorAction SilentlyContinue)
    $wanted = @('node','cmd','powershell','taskkill','cloudflared','chrome','dwm','MsMpEng','NisSrv','WerFault','conhost')
    foreach ($name in $wanted) {
        $rows = @($allProcesses | Where-Object { $_.ProcessName -ieq $name })
        if (-not $rows.Count) { continue }
        $processSummary += [pscustomobject]@{
            name = $name
            count = $rows.Count
            workingSetMB = [math]::Round((($rows | Measure-Object WorkingSet64 -Sum).Sum / 1MB), 1)
            privateMB = [math]::Round((($rows | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB), 1)
            handles = [int64](($rows | Measure-Object HandleCount -Sum).Sum)
            threads = [int64](($rows | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum)
        }
    }
    $cimRelevant = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '(?i)^(node|cmd|powershell|taskkill|cloudflared|werfault|procdump)\.exe$'
    })
    $processDetails = @($cimRelevant | Select-Object -First 80 | ForEach-Object {
        [pscustomobject]@{
            name = [string]$_.Name
            pid = [int]$_.ProcessId
            ppid = [int]$_.ParentProcessId
            sessionId = [int]$_.SessionId
            createdUtc = To-Iso $_.CreationDate
            command = Redact-Text $_.CommandLine 500
        }
    })
} catch {}

$scheduledTasks = @()
try {
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        foreach ($task in @(Get-ScheduledTask)) {
            $actionText = @($task.Actions | ForEach-Object {
                (Redact-Text (([string]$_.Execute) + ' ' + ([string]$_.Arguments) + ' ' + ([string]$_.WorkingDirectory)) 800)
            }) -join ' | '
            $hay = ([string]$task.TaskPath + [string]$task.TaskName + ' ' + $actionText)
            if ($hay -notmatch '(?i)conveniente|auto_vigia|node(\.exe)?|cmd(\.exe)?|powershell|taskkill|stop-process|shutdown|restart|reboot|clean|memory|standby|chrome|remote') { continue }
            $info = $null
            try { $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath } catch {}
            $triggers = @($task.Triggers | ForEach-Object {
                [pscustomobject]@{
                    type = if ($_.CimClass) { [string]$_.CimClass.CimClassName } else { $_.GetType().Name }
                    enabled = $_.Enabled
                    startBoundary = Redact-Text $_.StartBoundary 100
                    endBoundary = Redact-Text $_.EndBoundary 100
                    interval = if ($_.Repetition) { Redact-Text $_.Repetition.Interval 80 } else { $null }
                }
            })
            $scheduledTasks += [pscustomobject]@{
                path = ([string]$task.TaskPath + [string]$task.TaskName)
                state = [string]$task.State
                userId = Redact-Text $task.Principal.UserId 160
                logonType = [string]$task.Principal.LogonType
                runLevel = [string]$task.Principal.RunLevel
                actions = $actionText
                triggers = $triggers
                lastRunUtc = if ($info -and $info.LastRunTime.Year -gt 1900) { To-Iso $info.LastRunTime } else { $null }
                nextRunUtc = if ($info -and $info.NextRunTime.Year -gt 1900) { To-Iso $info.NextRunTime } else { $null }
                lastResult = if ($info) { [int64]$info.LastTaskResult } else { $null }
            }
            if ($scheduledTasks.Count -ge 120) { break }
        }
    }
} catch {}

$services = @()
try {
    $services = @(Get-CimInstance Win32_Service | Where-Object {
        $h = ([string]$_.Name + ' ' + [string]$_.DisplayName + ' ' + [string]$_.PathName)
        $h -match '(?i)defender|antivirus|security|endpoint|remote|chrome|google|clean|optim|memory|monitor|watch|vigia|conveniente|node|update'
    } | Select-Object -First 160 | ForEach-Object {
        [pscustomobject]@{
            name = [string]$_.Name
            displayName = Redact-Text $_.DisplayName 180
            state = [string]$_.State
            startMode = [string]$_.StartMode
            path = Redact-Text $_.PathName 600
        }
    })
} catch {}

$startup = @()
try {
    $startup = @(Get-CimInstance Win32_StartupCommand | Select-Object -First 120 | ForEach-Object {
        [pscustomobject]@{
            name = Redact-Text $_.Name 160
            location = Redact-Text $_.Location 180
            command = Redact-Text $_.Command 600
        }
    })
} catch {}

$installedPrograms = @()
try {
    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $seenPrograms = @{}
    foreach ($root in $uninstallRoots) {
        foreach ($p in @(Get-ItemProperty $root -ErrorAction SilentlyContinue)) {
            $name = [string]$p.DisplayName
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            $key = ($name + '|' + [string]$p.DisplayVersion).ToLowerInvariant()
            if ($seenPrograms.ContainsKey($key)) { continue }
            $seenPrograms[$key] = $true
            $installedPrograms += [pscustomobject]@{
                name = Redact-Text $name 220
                version = Redact-Text $p.DisplayVersion 100
                publisher = Redact-Text $p.Publisher 180
                installDate = Redact-Text $p.InstallDate 40
            }
        }
    }
    $installedPrograms = @($installedPrograms | Sort-Object name | Select-Object -First 350)
} catch {}

$antivirusProducts = @()
try {
    $antivirusProducts = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntivirusProduct | ForEach-Object {
        [pscustomobject]@{
            name = Redact-Text $_.displayName 180
            state = if ($null -ne $_.productState) { [int]$_.productState } else { $null }
            path = Redact-Text $_.pathToSignedProductExe 400
            reportingPath = Redact-Text $_.pathToSignedReportingExe 400
        }
    })
} catch {}

$defenderStatus = $null
try {
    if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
        $d = Get-MpComputerStatus
        $defenderStatus = [pscustomobject]@{
            antivirusEnabled = $d.AntivirusEnabled
            antispywareEnabled = $d.AntispywareEnabled
            behaviorMonitorEnabled = $d.BehaviorMonitorEnabled
            realTimeProtectionEnabled = $d.RealTimeProtectionEnabled
            ioavProtectionEnabled = $d.IoavProtectionEnabled
            niseEnabled = $d.NISEnabled
            onAccessProtectionEnabled = $d.OnAccessProtectionEnabled
            defenderSignaturesOutOfDate = $d.DefenderSignaturesOutOfDate
            antivirusSignatureVersion = Redact-Text $d.AntivirusSignatureVersion 100
            antivirusSignatureLastUpdatedUtc = To-Iso $d.AntivirusSignatureLastUpdated
            quickScanAge = $d.QuickScanAge
            fullScanAge = $d.FullScanAge
        }
    }
} catch {}

$defenderThreats = @()
try {
    if (Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue) {
        $defenderThreats = @(Get-MpThreatDetection |
            Sort-Object InitialDetectionTime -Descending |
            Select-Object -First 40 |
            ForEach-Object {
                [pscustomobject]@{
                    threatId = $_.ThreatID
                    threatStatusId = $_.ThreatStatusID
                    actionSuccess = $_.ActionSuccess
                    initialDetectionUtc = To-Iso $_.InitialDetectionTime
                    lastStatusChangeUtc = To-Iso $_.LastThreatStatusChangeTime
                    processName = Redact-Text $_.ProcessName 320
                    resources = Redact-Text (($_.Resources | ForEach-Object { [string]$_ }) -join ' | ') 1000
                }
            })
    }
} catch {}

$hotfixes = @()
try {
    $hotfixes = @(Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 30 | ForEach-Object {
        [pscustomobject]@{
            id = [string]$_.HotFixID
            description = Redact-Text $_.Description 120
            installedUtc = To-Iso $_.InstalledOn
        }
    })
} catch {}

$reliability = @()
try {
    $reliability = @(Get-CimInstance Win32_ReliabilityRecords |
        Where-Object {
            $_.TimeGenerated -ge $Since -and
            (([string]$_.ProductName + ' ' + [string]$_.SourceName + ' ' + [string]$_.Message) -match '(?i)node|cmd|chrome|dwm|conveniente|windows|hardware|stopped working|falha')
        } |
        Sort-Object TimeGenerated -Descending |
        Select-Object -First 100 |
        ForEach-Object {
            [pscustomobject]@{
                timeUtc = To-Iso $_.TimeGenerated
                source = Redact-Text $_.SourceName 180
                product = Redact-Text $_.ProductName 180
                eventId = Redact-Text $_.EventIdentifier 80
                message = Redact-Text $_.Message 700
            }
        })
} catch {}

$sessionText = $null
try { $sessionText = Redact-Text ((& quser.exe 2>&1 | Out-String) -replace '\r?\n', ' | ') 1400 } catch {}

$events = [ordered]@{
    application = @(Get-EventRows -LogName 'Application' -Ids @(1000,1001,1002) -Bag 'app_crash_hang' -Limit $MaxEvents)
    power = @(Get-EventRows -LogName 'System' -Ids @(41,1074,6005,6006,6008,6009) -Bag 'power' -Limit $MaxEvents)
    resourceExhaustion = @(Get-EventRows -LogName 'System' -Ids @(2004) -Bag 'resource_exhaustion' -ProviderRegex 'Resource-Exhaustion' -Limit $MaxEvents)
    hardwareDiskDisplay = @(Get-EventRows -LogName 'System' -Ids @(1,5,7,9,11,15,17,18,19,20,47,51,55,129,153,157,4101) -Bag 'hardware_disk_display' -ProviderRegex '(?i)WHEA|Display|nvlddmkm|amdkmdag|Disk|Ntfs|stor|volmgr' -Limit $MaxEvents)
    services = @(Get-EventRows -LogName 'System' -Ids @(7000,7001,7002,7009,7011,7023,7031,7034,7040,7045) -Bag 'service' -Limit $MaxEvents)
    defender = @(Get-EventRows -LogName 'Microsoft-Windows-Windows Defender/Operational' -Ids @(1006,1007,1008,1009,1116,1117,1118,1119,1121,1122,1129,5001,5004,5007,5010,5012) -Bag 'defender' -Limit $MaxEvents)
    taskScheduler = @(Get-EventRows -LogName 'Microsoft-Windows-TaskScheduler/Operational' -Ids @(100,101,102,106,107,110,111,118,119,129,140,141,142,200,201,202,203,311,319,323,327,328,329) -Bag 'task_scheduler' -Limit $MaxEvents)
    terminalSessions = @(Get-EventRows -LogName 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' -Ids @(21,22,23,24,25,39,40,41,42) -Bag 'terminal_session' -Limit $MaxEvents)
    remoteConnections = @(Get-EventRows -LogName 'Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational' -Ids @(1149) -Bag 'remote_connection' -Limit $MaxEvents)
    securitySessions = @(Get-EventRows -LogName 'Security' -Ids @(4624,4634,4647,4688,4689,4778,4779,4800,4801) -Bag 'security_session_process' -MessageRegex '(?i)node\.exe|cmd\.exe|taskkill|powershell|conveniente|logoff|logged off|encerrada|desconectad|bloquead' -Limit $MaxEvents)
    codeIntegrity = @(Get-EventRows -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -Ids @(3033,3034,3076,3077,3089) -Bag 'code_integrity' -Limit $MaxEvents)
    appLockerExe = @(Get-EventRows -LogName 'Microsoft-Windows-AppLocker/EXE and DLL' -Ids @(8002,8003,8004,8005,8028,8029,8036,8037) -Bag 'applocker' -Limit $MaxEvents)
}

$werKeys = @(
    (Get-RegistryValueSummary 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe'),
    (Get-RegistryValueSummary 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe')
) | Where-Object { $null -ne $_ }

$werServiceSummary = $null
try {
    $svc = Get-CimInstance Win32_Service -Filter "Name='WerSvc'"
    $werServiceSummary = [pscustomobject]@{
        state = [string]$svc.State
        startMode = [string]$svc.StartMode
        path = Redact-Text $svc.PathName 300
    }
} catch {}

$report = [ordered]@{
    ok = $true
    kind = 'windows_forensic_deep'
    collectedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    windowHours = $Hours
    identity = [pscustomobject]$identity
    os = $osInfo
    computer = $computerInfo
    cpu = $cpu
    memoryModules = $memoryModules
    memory = $memoryPerf
    pageFiles = $pageFiles
    gpu = $gpu
    diskDrives = $diskDrives
    logicalDisks = $logicalDisks
    physicalDiskHealth = $physicalDiskHealth
    processSummary = $processSummary
    processDetails = $processDetails
    scheduledTasks = $scheduledTasks
    services = $services
    startup = $startup
    installedPrograms = $installedPrograms
    antivirusProducts = $antivirusProducts
    defenderStatus = $defenderStatus
    defenderThreats = $defenderThreats
    hotfixes = $hotfixes
    reliability = $reliability
    sessions = $sessionText
    porteiroHistory = (Get-PorteiroHistory)
    diskClean = (Get-FileEvidence 'C:\ProgramData\US\Ess\LMP\DiskClean.exe')
    wer = [ordered]@{
        service = $werServiceSummary
        localDumpKeys = @($werKeys)
        dumps = @(Get-DumpInventory)
    }
    events = $events
}

try {
    $json = $report | ConvertTo-Json -Compress -Depth 9
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LastPath, $json, $utf8)
    Write-Output $json
} catch {
    $fallback = [ordered]@{
        ok = $false
        kind = 'windows_forensic_deep'
        collectedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        error = Redact-Text $_.Exception.Message 300
    } | ConvertTo-Json -Compress
    Write-Output $fallback
    exit 1
}
