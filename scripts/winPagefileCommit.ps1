# Pagefile 1:1 com a RAM fisica. Commit Limit no SSD.
# Nao mexe em Robe/Virtus/frota. Nao afirma cura de FastFail/Zone/heap.
# So grava se faltar. So aborta o boot se gravou ou se o ferro ainda nao aplicou (falta reboot).
# Sem UAC proprio. Sem admin: nao grava, nao mente, nao trava o Iniciar.

param(
    [switch]$Apply,
    [switch]$Check,
    [switch]$Quiet,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$Root = 'C:\conveniente'
$LogDir = Join-Path $Root 'dados\logs'
$TuneLog = Join-Path $LogDir 'windows_tuning.log'
$EngineLog = Join-Path $LogDir 'multi_engine.log'
$ForensicFile = Join-Path $LogDir 'windows_pagefile.forensic.jsonl'
$StateFile = Join-Path $LogDir 'windows_pagefile.state.json'
$RebootFile = Join-Path $LogDir 'windows_pagefile.REBOOT.txt'
$RegMm = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
$PagefileName = 'C:\pagefile.sys'
$RemainFreeBytes = [int64]30GB
$script:PfRunId = [guid]::NewGuid().ToString('N').Substring(0, 12)

function Test-PfAdmin {
    try {
        $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Ensure-PfDir {
    if (-not (Test-Path -LiteralPath $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
}

function Write-PfLine([string]$Path, [string]$Line, [string]$Enc) {
    try {
        Ensure-PfDir
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $Path -Value "$ts $Line" -Encoding $Enc
    } catch {}
}

function Write-PfTune([string]$Line) { Write-PfLine $TuneLog $Line 'ASCII' }
function Write-PfEngine([string]$Line) { Write-PfLine $EngineLog $Line 'UTF8' }

function Write-PfForensic([hashtable]$Obj) {
    try {
        Ensure-PfDir
        $now = Get-Date
        $rec = [ordered]@{
            ts = [int64]([DateTimeOffset]$now).ToUnixTimeMilliseconds()
            iso = $now.ToString('o')
            event = 'pagefile'
            host = $env:COMPUTERNAME
            user = $env:USERNAME
            admin = [bool](Test-PfAdmin)
            dryRun = [bool]$DryRun
            runId = $script:PfRunId
            pid = $PID
        }
        if ($null -ne $Obj) {
            foreach ($k in $Obj.Keys) { $rec[$k] = $Obj[$k] }
        }
        Add-Content -LiteralPath $ForensicFile -Value ($rec | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
    } catch {}
}

function Save-PfState($Obj) {
    try {
        Ensure-PfDir
        ($Obj | ConvertTo-Json -Compress -Depth 8) | Set-Content -LiteralPath $StateFile -Encoding UTF8
    } catch {}
}

function Get-PhysicalRamGb {
    $bytes = [int64]0
    $source = 'none'
    try {
        $dimms = @(Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop)
        if ($dimms.Count -gt 0) {
            $bytes = [int64](($dimms | Measure-Object -Property Capacity -Sum).Sum)
            $source = 'Win32_PhysicalMemory'
        }
    } catch {}
    if ($bytes -le 0) {
        try {
            $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
            $bytes = [int64]$cs.TotalPhysicalMemory
            $source = 'Win32_ComputerSystem'
        } catch {}
    }
    if ($bytes -le 0) {
        return [pscustomobject]@{ Ok = $false; Bytes = [int64]0; Gb = 0; Mb = 0; Source = $source }
    }
    $gb = [int][math]::Round(([double]$bytes) / 1GB)
    if ($gb -lt 1) {
        return [pscustomobject]@{ Ok = $false; Bytes = $bytes; Gb = 0; Mb = 0; Source = $source }
    }
    return [pscustomobject]@{
        Ok = $true
        Bytes = $bytes
        Gb = $gb
        Mb = ($gb * 1024)
        Source = $source
    }
}

function Get-CDriveFreeBytes {
    try {
        $d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop
        return [int64]$d.FreeSpace
    } catch { return [int64]0 }
}

function Normalize-PfPath([string]$Name) {
    $n = ([string]$Name).Trim().Trim('"')
    if (-not $n) { return '' }
    return $n
}

function Test-IsCPagefile([string]$Name) {
    $n = Normalize-PfPath $Name
    if (-not $n) { return $false }
    $n = $n -replace '\\+', '\'
    return [bool]($n -match '^[Cc]:\\pagefile\.sys$')
}

function Get-AutomaticManaged {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        if ($null -eq $cs.AutomaticManagedPagefile) { return $null }
        return [bool]$cs.AutomaticManagedPagefile
    } catch { return $null }
}

function Get-PagingFileLines {
    $out = @()
    try {
        $v = (Get-ItemProperty -LiteralPath $RegMm -Name 'PagingFiles' -ErrorAction Stop).PagingFiles
        if ($null -eq $v) { return @() }
        if ($v -is [string]) { return @([string]$v) }
        foreach ($x in @($v)) {
            $s = [string]$x
            if (-not [string]::IsNullOrWhiteSpace($s)) { $out += $s }
        }
    } catch {}
    return @($out)
}

function Parse-PagingLine([string]$Line) {
    $s = ([string]$Line).Trim()
    if ($s -match '^([A-Za-z]:\\pagefile\.sys)\s+(\d+)\s+(\d+)\s*$') {
        return [pscustomobject]@{
            Name = $Matches[1]
            InitialMb = [int]$Matches[2]
            MaximumMb = [int]$Matches[3]
            Managed = $false
            Raw = $s
        }
    }
    if ($s -match '^([A-Za-z]:\\pagefile\.sys)\s*$') {
        return [pscustomobject]@{
            Name = $Matches[1]
            InitialMb = 0
            MaximumMb = 0
            Managed = $true
            Raw = $s
        }
    }
    return $null
}

function Get-CPagefileUsageMb {
    try {
        $rows = @(Get-CimInstance -ClassName Win32_PageFileUsage -ErrorAction Stop)
        foreach ($r in $rows) {
            if (Test-IsCPagefile ([string]$r.Name)) {
                return [int]$r.AllocatedBaseSize
            }
        }
    } catch {}
    return 0
}

function Get-CPagefileSetting {
    try {
        $rows = @(Get-CimInstance -ClassName Win32_PageFileSetting -ErrorAction Stop)
        foreach ($r in $rows) {
            if (Test-IsCPagefile ([string]$r.Name)) { return $r }
        }
    } catch {}
    return $null
}

function Get-ConvenientePagefileCommitReport {
    $ram = Get-PhysicalRamGb
    $auto = Get-AutomaticManaged
    $lines = @(Get-PagingFileLines)
    $parsed = @()
    $cLine = $null
    foreach ($ln in $lines) {
        $p = Parse-PagingLine $ln
        if ($null -eq $p) { continue }
        $parsed += $p
        if (Test-IsCPagefile $p.Name) { $cLine = $p }
    }
    $usageMb = Get-CPagefileUsageMb
    $freeBytes = Get-CDriveFreeBytes
    $wantMb = 0
    if ($ram.Ok) { $wantMb = [int]$ram.Mb }
    $regExact = $false
    if ($cLine -and -not $cLine.Managed -and $wantMb -gt 0) {
        $regExact = (($cLine.InitialMb -eq $wantMb) -and ($cLine.MaximumMb -eq $wantMb))
    }
    $autoOff = ($auto -eq $false)
    $usageClose = $false
    if ($wantMb -gt 0 -and $usageMb -gt 0) {
        $usageClose = ([math]::Abs(([int]$usageMb) - [int]$wantMb) -le 64)
    }
    $liveExact = [bool]$usageClose
    $setting = Get-CPagefileSetting
    $settingExact = $false
    if ($setting -and $wantMb -gt 0) {
        try {
            $settingExact = (([int]$setting.InitialSize -eq $wantMb) -and ([int]$setting.MaximumSize -eq $wantMb))
        } catch { $settingExact = $false }
    }
    $configured = [bool]($autoOff -and $regExact)
    $live = [bool]($configured -and $liveExact)
    $currentPfBytes = [int64]$usageMb * 1MB
    $wantBytes = [int64]$wantMb * 1MB
    $delta = [int64]$wantBytes - [int64]$currentPfBytes
    $freeAfter = [int64]$freeBytes - [int64]$delta
    return [pscustomobject]@{
        RamOk = [bool]$ram.Ok
        RamSource = [string]$ram.Source
        RamBytes = [int64]$ram.Bytes
        RamGb = [int]$ram.Gb
        WantMb = [int]$wantMb
        AutoManaged = $auto
        AutoOff = $autoOff
        PagingLines = @($lines)
        CInitialMb = $(if ($cLine) { [int]$cLine.InitialMb } else { 0 })
        CMaximumMb = $(if ($cLine) { [int]$cLine.MaximumMb } else { 0 })
        CManagedLine = $(if ($cLine) { [bool]$cLine.Managed } else { $true })
        UsageMb = [int]$usageMb
        SettingExact = [bool]$settingExact
        RegExact = [bool]$regExact
        Configured = [bool]$configured
        Live = [bool]$live
        PendingReboot = [bool]($configured -and -not $liveExact)
        CFreeBytes = [int64]$freeBytes
        CFreeAfterBytes = [int64]$freeAfter
        GrowBytes = [int64]$delta
        DiskOk = [bool]($freeAfter -ge $RemainFreeBytes)
        Admin = [bool](Test-PfAdmin)
    }
}

function Set-AutomaticManagedOff {
    try {
        $cs = Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop
        if ([bool]$cs.AutomaticManagedPagefile) {
            $cs.AutomaticManagedPagefile = $false
            [void]$cs.Put()
        }
        return $true
    } catch {
        try {
            $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
            Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false } -ErrorAction Stop
            return $true
        } catch { return $false }
    }
}

function Set-PagingFilesRegistry([int]$WantMb, [object]$Report) {
    $keep = @()
    foreach ($ln in @($Report.PagingLines)) {
        $raw = [string]$ln
        $p = Parse-PagingLine $raw
        if ($null -eq $p) {
            if ($raw -and ($raw -notmatch '^[Cc]:\\')) { $keep += $raw }
            continue
        }
        if (Test-IsCPagefile $p.Name) { continue }
        $keep += [string]$p.Raw
    }
    $keep += ($PagefileName + ' ' + $WantMb + ' ' + $WantMb)
    Set-ItemProperty -LiteralPath $RegMm -Name 'PagingFiles' -Value ([string[]]$keep) -Type MultiString -Force -ErrorAction Stop
}

function Set-PageFileSettingWmi([int]$WantMb) {
    try {
        $cur = $null
        $rows = @(Get-WmiObject -Class Win32_PageFileSetting -ErrorAction SilentlyContinue)
        foreach ($r in $rows) {
            if (Test-IsCPagefile ([string]$r.Name)) { $cur = $r; break }
        }
        if ($cur) {
            $cur.InitialSize = $WantMb
            $cur.MaximumSize = $WantMb
            [void]$cur.Put()
            return $true
        }
        Set-WmiInstance -Class Win32_PageFileSetting -Arguments @{
            Name = $PagefileName
            InitialSize = $WantMb
            MaximumSize = $WantMb
        } -ErrorAction Stop | Out-Null
        return $true
    } catch { return $false }
}

function Show-CommitRebootAlert([string]$Text) {
    try {
        Ensure-PfDir
        Set-Content -LiteralPath $RebootFile -Value $Text -Encoding UTF8
    } catch {}
    Write-Host ''
    Write-Host $Text
    Write-Host ''
    try {
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $safe = $RebootFile.Replace("'", "''")
        $cmd = @"
`$Host.UI.RawUI.WindowTitle = 'AVISO_FATAL_REBOOT'
Write-Host ''
Write-Host '[AVISO_FATAL_REBOOT]' -ForegroundColor Yellow
Write-Host ''
Get-Content -LiteralPath '$safe' -Encoding UTF8 | ForEach-Object { Write-Host `$_ }
Write-Host ''
Read-Host 'Reinicie o Windows. Enter fecha esta janela'
"@
        Start-Process -FilePath $psExe -WindowStyle Normal -Wait -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
        ) | Out-Null
    } catch {}
}

function New-PfResult {
    param(
        [Parameter(Mandatory = $true)][string]$Reason,
        [bool]$AbortBoot = $false,
        [object]$Report = $null,
        [string]$Detail = ''
    )
    $wantMb = 0
    $ramGb = 0
    if ($Report) {
        $wantMb = [int]$Report.WantMb
        $ramGb = [int]$Report.RamGb
    }
    $alert = ''
    if ($AbortBoot) {
        $alert = @(
            '[AVISO_FATAL_REBOOT] O Commit Limit da maquina foi expandido de forma enterprise para o espelho 1:1 (pagefile = RAM).',
            ('RAM detectada: ' + $ramGb + ' GB. Pagefile gravado: ' + $wantMb + ' MB / ' + $wantMb + ' MB em C:\pagefile.sys.'),
            'REINICIE O SERVIDOR AGORA para travar a alteracao no ferro antes de operar.',
            'Nao clique Iniciar de novo ate o Windows voltar. O Conveniente nao sobe enquanto o reboot nao aplicar o pagefile.'
        ) -join [Environment]::NewLine
    }
    $obj = [pscustomobject]@{
        Ok = [bool]($Reason -eq 'already_ok')
        AbortBoot = [bool]$AbortBoot
        Reason = $Reason
        Detail = $Detail
        AlertText = $alert
        RamGb = $ramGb
        WantMb = $wantMb
        Report = $Report
    }
    Save-PfState @{
        ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
        iso = [DateTime]::UtcNow.ToString('o')
        reason = $Reason
        abortBoot = [bool]$AbortBoot
        ramGb = $ramGb
        wantMb = $wantMb
        detail = $Detail
        live = $(if ($Report) { [bool]$Report.Live } else { $false })
        configured = $(if ($Report) { [bool]$Report.Configured } else { $false })
        usageMb = $(if ($Report) { [int]$Report.UsageMb } else { 0 })
        autoManaged = $(if ($Report) { $Report.AutoManaged } else { $null })
        diskOk = $(if ($Report) { [bool]$Report.DiskOk } else { $false })
        admin = [bool](Test-PfAdmin)
        runId = $script:PfRunId
    }
    Write-PfForensic @{
        event = 'result'
        reason = $Reason
        abortBoot = [bool]$AbortBoot
        detail = $Detail
        ramGb = $ramGb
        wantMb = $wantMb
        before = $(if ($Report) { $Report.PagingLines } else { $null })
        after = $null
        usageMb = $(if ($Report) { [int]$Report.UsageMb } else { 0 })
        autoManaged = $(if ($Report) { $Report.AutoManaged } else { $null })
        cFreeGb = $(if ($Report) { [math]::Round(([double]$Report.CFreeBytes) / 1GB, 1) } else { 0 })
        freeAfterGb = $(if ($Report) { [math]::Round(([double]$Report.CFreeAfterBytes) / 1GB, 1) } else { 0 })
    }
    return $obj
}

function Invoke-ConvenientePagefileCommit {
    param([switch]$Apply)
    $doApply = $true
    if ($PSBoundParameters.ContainsKey('Apply')) { $doApply = [bool]$Apply }
    $rep = Get-ConvenientePagefileCommitReport
    if (-not $rep.RamOk -or $rep.WantMb -lt 1024) {
        Write-PfTune ('PAGEFILE skip=no_ram source=' + $rep.RamSource)
        return (New-PfResult -Reason 'no_ram' -Report $rep -Detail ([string]$rep.RamSource))
    }
    if ($rep.Live) {
        $msg = '[INFRA_BLINDAGEM_OK] Commit Limit validado e travado no espelho 1:1 ramGb=' + $rep.RamGb + ' pagefileMb=' + $rep.WantMb
        $logOk = $true
        try {
            if (Test-Path -LiteralPath $StateFile) {
                $prev = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $prevTs = [int64]$prev.ts
                if (([string]$prev.reason -eq 'already_ok') -and $prevTs -gt 0 -and (([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $prevTs) -lt (6 * 60 * 60 * 1000))) {
                    $logOk = $false
                }
            }
        } catch { $logOk = $true }
        if ($logOk) { Write-PfEngine $msg }
        Write-PfTune ('PAGEFILE ok live ramGb=' + $rep.RamGb + ' mb=' + $rep.WantMb)
        return (New-PfResult -Reason 'already_ok' -Report $rep -Detail $msg)
    }
    if ($rep.PendingReboot) {
        Write-PfTune ('PAGEFILE pending_reboot ramGb=' + $rep.RamGb + ' want=' + $rep.WantMb + ' usage=' + $rep.UsageMb)
        return (New-PfResult -Reason 'pending_reboot' -AbortBoot $true -Report $rep -Detail 'settings_ok usage_old')
    }
    if (-not $rep.DiskOk) {
        $needGb = [math]::Round(([double]$rep.GrowBytes) / 1GB, 1)
        $freeGb = [math]::Round(([double]$rep.CFreeBytes) / 1GB, 1)
        $afterGb = [math]::Round(([double]$rep.CFreeAfterBytes) / 1GB, 1)
        $d = 'needGrowGb=' + $needGb + ' freeGb=' + $freeGb + ' afterGb=' + $afterGb + ' remainMinGb=30'
        Write-PfTune ('PAGEFILE skip=no_disk ' + $d)
        return (New-PfResult -Reason 'no_disk' -Report $rep -Detail $d)
    }
    if (-not $rep.Admin) {
        Write-PfTune ('PAGEFILE skip=no_admin wantMb=' + $rep.WantMb)
        return (New-PfResult -Reason 'no_admin' -Report $rep -Detail 'HKLM pagefile precisa admin; Setup -Apply elevado grava')
    }
    if ($DryRun -or -not $doApply) {
        Write-PfTune ('PAGEFILE skip=dryrun wantMb=' + $rep.WantMb)
        return (New-PfResult -Reason 'dryrun' -Report $rep -Detail 'nao gravou')
    }

    $beforeLines = @($rep.PagingLines)
    $autoOk = Set-AutomaticManagedOff
    $wmiOk = $false
    $regOk = $false
    $regErr = ''
    try {
        Set-PagingFilesRegistry -WantMb ([int]$rep.WantMb) -Report $rep
        $regOk = $true
    } catch {
        $regErr = [string]$_.Exception.Message
    }
    try { $wmiOk = [bool](Set-PageFileSettingWmi -WantMb ([int]$rep.WantMb)) } catch { $wmiOk = $false }

    $after = Get-ConvenientePagefileCommitReport
    $wrote = [bool]($after.Configured)
    Write-PfForensic @{
        event = 'apply'
        ok = $wrote
        before = $beforeLines
        after = @($after.PagingLines)
        autoOffOk = $autoOk
        wmiOk = $wmiOk
        regOk = $regOk
        regErr = $regErr
        wantMb = [int]$rep.WantMb
    }
    if ($wrote) {
        Write-PfTune ('PAGEFILE applied ramGb=' + $after.RamGb + ' mb=' + $after.WantMb + ' reboot=1')
        return (New-PfResult -Reason 'applied_reboot' -AbortBoot $true -Report $after -Detail 'registry_ok')
    }
    Write-PfTune ('PAGEFILE apply_failed auto=' + $autoOk + ' wmi=' + $wmiOk + ' reg=' + $regOk + ' err=' + $regErr)
    return (New-PfResult -Reason 'apply_failed' -Report $after -Detail $regErr)
}

$script:ConvenientePagefileDotSourced = ($MyInvocation.InvocationName -eq '.')
if (-not $script:ConvenientePagefileDotSourced) {
    if ($Check -and -not $Apply) {
        $r = Get-ConvenientePagefileCommitReport
        $r | ConvertTo-Json -Compress -Depth 6
        exit 0
    }
    $out = Invoke-ConvenientePagefileCommit -Apply
    if ($out.AbortBoot) {
        if (-not $Quiet) {
            Show-CommitRebootAlert ([string]$out.AlertText)
        } else {
            try { Set-Content -LiteralPath $RebootFile -Value ([string]$out.AlertText) -Encoding UTF8 } catch {}
            Write-Host ([string]$out.AlertText)
        }
        exit 2
    }
    if ($out.Ok) { exit 0 }
    exit 3
}
