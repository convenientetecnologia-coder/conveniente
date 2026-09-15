# Pagefile 1:1 com a RAM fisica. Commit Limit no SSD.
# Nao mexe em Robe/Virtus/frota. Nao afirma cura de FastFail/Zone/heap.
# So grava se o C:\pagefile.sys NAO esta fixo em RAM/RAM. Faixa 128-8192 ou 2-4GB NAO e 1:1.
# So aborta o boot se gravou NESTE boot ou se o ferro ainda nao reiniciou depois da gravacao.
# Depois do reboot, se o Windows nao honrou o tamanho: nao pede reboot eterno, nao trava o Iniciar.
# Sem UAC proprio. Iniciar no token filtrado nao grava HKLM: pede ConvenienteNetBoot (SYSTEM).
# RAM = MAX das fontes (DIMM, ComputerSystem, OS visivel). Nao fica no primeiro DIMM.

param(
    [switch]$Apply,
    [switch]$Check,
    [switch]$Quiet,
    [switch]$DryRun,
    [switch]$SelfTest
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

function Test-PfSystem {
    try {
        return [bool]([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem)
    } catch { return $false }
}

function Invoke-PfViaSystemTask {
    $destKit = 'C:\auto_vigia\manutencao.ps1'
    $flagDest = 'C:\auto_vigia\PAGEFILE_NOW.flag'
    $flagLog = Join-Path $LogDir 'PAGEFILE_NOW.flag'
    if (-not (Test-Path -LiteralPath $destKit)) { return $null }
    $kitTxt = ''
    try { $kitTxt = [string](Get-Content -LiteralPath $destKit -Raw -ErrorAction Stop) } catch { $kitTxt = '' }
    if ($kitTxt -notmatch 'PAGEFILE_NOW') { return $null }
    $beforeTs = [int64]0
    $prev = Read-PfStateObj
    if ($prev) { try { $beforeTs = [int64]$prev.ts } catch { $beforeTs = [int64]0 } }
    $wrote = $false
    try {
        if (-not (Test-Path -LiteralPath 'C:\auto_vigia')) {
            New-Item -ItemType Directory -Path 'C:\auto_vigia' -Force | Out-Null
        }
        Set-Content -LiteralPath $flagDest -Value '1' -Encoding ASCII
        $wrote = $true
    } catch {}
    try {
        Ensure-PfDir
        Set-Content -LiteralPath $flagLog -Value '1' -Encoding ASCII
        $wrote = $true
    } catch {}
    if (-not $wrote) { return $null }
    & schtasks.exe /Run /TN ConvenienteNetBoot 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        try { Remove-Item -LiteralPath $flagDest -Force -ErrorAction SilentlyContinue } catch {}
        try { Remove-Item -LiteralPath $flagLog -Force -ErrorAction SilentlyContinue } catch {}
        return $null
    }
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $now = Read-PfStateObj
        if ($now) {
            $ts = [int64]0
            try { $ts = [int64]$now.ts } catch { $ts = [int64]0 }
            if ($ts -gt $beforeTs) { return $now }
        }
    }
    return $null
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

function Get-PfRamPick {
    param([object[]]$Cands)
    $bestBytes = [int64]0
    $bestSource = 'none'
    $all = @()
    foreach ($c in @($Cands)) {
        if ($null -eq $c) { continue }
        $b = [int64]0
        try { $b = [int64]$c.Bytes } catch { $b = [int64]0 }
        $s = [string]$c.Source
        if ($b -gt 0) { $all += ($s + '=' + [int][math]::Round(([double]$b) / 1GB) + 'GB') }
        if ($b -gt $bestBytes) {
            $bestBytes = $b
            $bestSource = $s
        }
    }
    if ($bestBytes -le 0) {
        return [pscustomobject]@{ Ok = $false; Bytes = [int64]0; Gb = 0; Mb = 0; Source = $bestSource; Sources = ($all -join ',') }
    }
    $gb = [int][math]::Round(([double]$bestBytes) / 1GB)
    if ($gb -lt 1) {
        return [pscustomobject]@{ Ok = $false; Bytes = $bestBytes; Gb = 0; Mb = 0; Source = $bestSource; Sources = ($all -join ',') }
    }
    return [pscustomobject]@{
        Ok = $true
        Bytes = $bestBytes
        Gb = $gb
        Mb = ($gb * 1024)
        Source = $bestSource
        Sources = ($all -join ',')
    }
}

function Get-PhysicalRamGb {
    $cands = @()
    try {
        $dimms = @(Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop)
        if ($dimms.Count -gt 0) {
            $sum = [int64](($dimms | Measure-Object -Property Capacity -Sum).Sum)
            if ($sum -gt 0) { $cands += [pscustomobject]@{ Bytes = $sum; Source = 'Win32_PhysicalMemory' } }
        }
    } catch {}
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $b = [int64]$cs.TotalPhysicalMemory
        if ($b -gt 0) { $cands += [pscustomobject]@{ Bytes = $b; Source = 'Win32_ComputerSystem' } }
    } catch {}
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $b = [int64]$os.TotalVisibleMemorySize * 1024
        if ($b -gt 0) { $cands += [pscustomobject]@{ Bytes = $b; Source = 'Win32_OperatingSystem' } }
    } catch {}
    return (Get-PfRamPick -Cands $cands)
}

function Get-CDriveFreeBytes {
    try {
        $d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop
        if ($null -ne $d -and [int64]$d.FreeSpace -gt 0) { return [int64]$d.FreeSpace }
    } catch {}
    try {
        $di = New-Object -TypeName System.IO.DriveInfo -ArgumentList 'C:\'
        if ($di.AvailableFreeSpace -gt 0) { return [int64]$di.AvailableFreeSpace }
    } catch {}
    return [int64]0
}

function Get-PfBootTime {
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        return [DateTime]$os.LastBootUpTime
    } catch { return $null }
}

function Get-PfBootStamp {
    try {
        $dt = Get-PfBootTime
        if ($null -eq $dt) { return '' }
        return $dt.ToUniversalTime().ToString('o')
    } catch { return '' }
}

function Read-PfStateObj {
    try {
        if (Test-Path -LiteralPath $StateFile) {
            return (Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json)
        }
    } catch {}
    return $null
}

function Get-PfDiskMath([int]$WantMb, [int]$CurrentPfMb, [int64]$FreeBytes) {
    if ($WantMb -lt 0) { $WantMb = 0 }
    if ($CurrentPfMb -lt 0) { $CurrentPfMb = 0 }
    $wantBytes = [int64]$WantMb * 1MB
    $currentBytes = [int64]$CurrentPfMb * 1MB
    $delta = [int64]$wantBytes - [int64]$currentBytes
    $after = [int64]$FreeBytes - [int64]$delta
    return [pscustomobject]@{
        GrowBytes = [int64]$delta
        FreeAfterBytes = [int64]$after
        DiskOk = [bool]($after -ge $RemainFreeBytes)
    }
}

function Get-CPagefileFileMb {
    try {
        $i = Get-Item -LiteralPath $PagefileName -Force -ErrorAction Stop
        if ($i.Length -gt 0) { return [int][math]::Ceiling(([double]$i.Length) / 1MB) }
    } catch {}
    try {
        $row = Get-CimInstance -ClassName CIM_DataFile -Filter "Name='C:\\pagefile.sys'" -ErrorAction Stop
        if ($row -and [int64]$row.FileSize -gt 0) {
            return [int][math]::Ceiling(([double]$row.FileSize) / 1MB)
        }
    } catch {}
    try {
        $cmd = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $out = & $cmd /c 'dir /a /-c C:\pagefile.sys'
        foreach ($line in @($out)) {
            $s = [string]$line
            if ($s -match '(?i)(\d+)\s+pagefile\.sys') {
                $n = [int64]$Matches[1]
                if ($n -gt 0) { return [int][math]::Ceiling(([double]$n) / 1MB) }
            }
        }
    } catch {}
    return 0
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
    $fileMb = Get-CPagefileFileMb
    $currentPfMb = [int]$usageMb
    if ([int]$fileMb -gt $currentPfMb) { $currentPfMb = [int]$fileMb }
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
    $settingIni = 0
    $settingMax = 0
    if ($setting -and $wantMb -gt 0) {
        try {
            $settingIni = [int]$setting.InitialSize
            $settingMax = [int]$setting.MaximumSize
            $settingExact = (($settingIni -eq $wantMb) -and ($settingMax -eq $wantMb))
        } catch { $settingExact = $false }
    }
    $configured = [bool]($autoOff -and $regExact)
    $live = [bool]($configured -and $liveExact)
    $disk = Get-PfDiskMath -WantMb $wantMb -CurrentPfMb $currentPfMb -FreeBytes $freeBytes
    return [pscustomobject]@{
        RamOk = [bool]$ram.Ok
        RamSource = [string]$ram.Source
        RamSources = $(if ($ram.PSObject.Properties['Sources']) { [string]$ram.Sources } else { [string]$ram.Source })
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
        FileMb = [int]$fileMb
        CurrentPfMb = [int]$currentPfMb
        SettingInitialMb = [int]$settingIni
        SettingMaximumMb = [int]$settingMax
        SettingExact = [bool]$settingExact
        RegExact = [bool]$regExact
        Configured = [bool]$configured
        Live = [bool]$live
        PendingReboot = [bool]($configured -and -not $liveExact)
        CFreeBytes = [int64]$freeBytes
        CFreeAfterBytes = [int64]$disk.FreeAfterBytes
        GrowBytes = [int64]$disk.GrowBytes
        DiskOk = [bool]$disk.DiskOk
        Admin = [bool](Test-PfAdmin)
        BootStamp = Get-PfBootStamp
    }
}

function Test-PfRebootedSinceApply([bool]$Configured = $false) {
    $boot = Get-PfBootStamp
    $st = Read-PfStateObj
    if ($st -and $boot) {
        $applied = ''
        try { $applied = [string]$st.appliedBootStamp } catch { $applied = '' }
        if ($applied -and ($applied -ne $boot)) { return $true }
    }
    if (-not $Configured) { return $false }
    $bootTime = Get-PfBootTime
    if ($null -ne $bootTime -and (Test-Path -LiteralPath $RebootFile)) {
        try {
            $wt = (Get-Item -LiteralPath $RebootFile).LastWriteTime
            if ($wt -lt $bootTime) { return $true }
        } catch {}
    }
    return $false
}

function Resolve-PfDecision {
    param(
        [Parameter(Mandatory = $true)]$Report,
        [bool]$RebootedSinceApply = $false,
        [int]$ApplyCount = 0,
        [bool]$DoApply = $true,
        [bool]$DryRunFlag = $false
    )
    if (-not $Report.RamOk -or [int]$Report.WantMb -lt 1024) {
        return [pscustomobject]@{ Reason = 'no_ram'; AbortBoot = $false }
    }
    if ([bool]$Report.Live) {
        return [pscustomobject]@{ Reason = 'already_ok'; AbortBoot = $false }
    }
    # DiskOk so autoriza GRAVAR. 1:1 ja no ferro nunca cai aqui. Sem 30 GB nao desfaz nada.
    if ($RebootedSinceApply -and [bool]$Report.Configured) {
        return [pscustomobject]@{ Reason = 'live_mismatch'; AbortBoot = $false }
    }
    if ($RebootedSinceApply -and $ApplyCount -ge 2 -and -not [bool]$Report.Configured) {
        return [pscustomobject]@{ Reason = 'apply_cap'; AbortBoot = $false }
    }
    if ([bool]$Report.PendingReboot) {
        return [pscustomobject]@{ Reason = 'pending_reboot'; AbortBoot = $true }
    }
    if (-not [bool]$Report.DiskOk) {
        return [pscustomobject]@{ Reason = 'no_disk'; AbortBoot = $false }
    }
    if (-not [bool]$Report.Admin) {
        return [pscustomobject]@{ Reason = 'no_admin'; AbortBoot = $false }
    }
    if ($DryRunFlag -or -not $DoApply) {
        return [pscustomobject]@{ Reason = 'dryrun'; AbortBoot = $false }
    }
    return [pscustomobject]@{ Reason = 'should_apply'; AbortBoot = $false }
}

function New-PfFakeReport {
    param(
        [int]$RamGb = 16,
        [int]$WantMb = 16384,
        [bool]$RamOk = $true,
        [bool]$AutoOff = $true,
        [int]$Ini = 128,
        [int]$Max = 8192,
        [int]$UsageMb = 191,
        [int64]$FreeBytes = 0,
        [bool]$Admin = $true,
        [bool]$Managed = $false
    )
    $regExact = (-not $Managed -and $WantMb -gt 0 -and $Ini -eq $WantMb -and $Max -eq $WantMb)
    $configured = [bool]($AutoOff -and $regExact)
    $usageClose = ($WantMb -gt 0 -and $UsageMb -gt 0 -and ([math]::Abs($UsageMb - $WantMb) -le 64))
    $disk = Get-PfDiskMath -WantMb $WantMb -CurrentPfMb $UsageMb -FreeBytes $FreeBytes
    return [pscustomobject]@{
        RamOk = $RamOk
        WantMb = $WantMb
        RamGb = $RamGb
        AutoOff = $AutoOff
        CInitialMb = $Ini
        CMaximumMb = $Max
        UsageMb = $UsageMb
        CurrentPfMb = $UsageMb
        RegExact = $regExact
        Configured = $configured
        Live = [bool]($configured -and $usageClose)
        PendingReboot = [bool]($configured -and -not $usageClose)
        DiskOk = [bool]$disk.DiskOk
        Admin = $Admin
        GrowBytes = $disk.GrowBytes
        CFreeAfterBytes = $disk.FreeAfterBytes
        CFreeBytes = $FreeBytes
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
    $bootStamp = Get-PfBootStamp
    $prev = Read-PfStateObj
    $appliedBoot = ''
    $applyCount = 0
    if ($prev) {
        try { $appliedBoot = [string]$prev.appliedBootStamp } catch { $appliedBoot = '' }
        try { $applyCount = [int]$prev.applyCount } catch { $applyCount = 0 }
    }
    if ($Reason -eq 'already_ok') {
        $appliedBoot = ''
        $applyCount = 0
    } elseif ($Reason -eq 'applied_reboot') {
        $sameBoot = ($appliedBoot -and ($appliedBoot -eq $bootStamp))
        if (-not $sameBoot) {
            $appliedBoot = $bootStamp
            $applyCount = $applyCount + 1
        }
    } elseif ($Reason -eq 'pending_reboot') {
        if (-not $appliedBoot) { $appliedBoot = $bootStamp }
    }
    $ramSource = ''
    $ramSources = ''
    if ($Report) {
        try { $ramSource = [string]$Report.RamSource } catch { $ramSource = '' }
        try { $ramSources = [string]$Report.RamSources } catch { $ramSources = '' }
    }
    Save-PfState @{
        ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
        iso = [DateTime]::UtcNow.ToString('o')
        reason = $Reason
        abortBoot = [bool]$AbortBoot
        ramGb = $ramGb
        ramSource = $ramSource
        ramSources = $ramSources
        wantMb = $wantMb
        detail = $Detail
        live = $(if ($Report) { [bool]$Report.Live } else { $false })
        configured = $(if ($Report) { [bool]$Report.Configured } else { $false })
        usageMb = $(if ($Report) { [int]$Report.UsageMb } else { 0 })
        currentPfMb = $(if ($Report) { [int]$Report.CurrentPfMb } else { 0 })
        cInitialMb = $(if ($Report) { [int]$Report.CInitialMb } else { 0 })
        cMaximumMb = $(if ($Report) { [int]$Report.CMaximumMb } else { 0 })
        autoManaged = $(if ($Report) { $Report.AutoManaged } else { $null })
        diskOk = $(if ($Report) { [bool]$Report.DiskOk } else { $false })
        admin = [bool](Test-PfAdmin)
        runId = $script:PfRunId
        bootStamp = $bootStamp
        appliedBootStamp = $appliedBoot
        applyCount = $applyCount
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
    $prev = Read-PfStateObj
    $applyCount = 0
    if ($prev) { try { $applyCount = [int]$prev.applyCount } catch { $applyCount = 0 } }
    $rebooted = Test-PfRebootedSinceApply -Configured ([bool]$rep.Configured)
    $dec = Resolve-PfDecision -Report $rep -RebootedSinceApply $rebooted -ApplyCount $applyCount -DoApply $doApply -DryRunFlag ([bool]$DryRun)
    if ($dec.Reason -eq 'no_ram') {
        Write-PfTune ('PAGEFILE skip=no_ram source=' + $rep.RamSource)
        return (New-PfResult -Reason 'no_ram' -Report $rep -Detail ([string]$rep.RamSource))
    }
    if ($dec.Reason -eq 'already_ok') {
        $msg = '[INFRA_BLINDAGEM_OK] Commit Limit validado e travado no espelho 1:1 ramGb=' + $rep.RamGb + ' pagefileMb=' + $rep.WantMb
        $logOk = $true
        try {
            if ($prev -and ([string]$prev.reason -eq 'already_ok')) {
                $prevTs = [int64]$prev.ts
                if ($prevTs -gt 0 -and (([DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $prevTs) -lt (6 * 60 * 60 * 1000))) {
                    $logOk = $false
                }
            }
        } catch { $logOk = $true }
        if ($logOk) { Write-PfEngine $msg }
        Write-PfTune ('PAGEFILE ok live ramGb=' + $rep.RamGb + ' mb=' + $rep.WantMb + ' ini=' + $rep.CInitialMb + ' max=' + $rep.CMaximumMb)
        return (New-PfResult -Reason 'already_ok' -Report $rep -Detail $msg)
    }
    if ($dec.Reason -eq 'pending_reboot') {
        Write-PfTune ('PAGEFILE pending_reboot ramGb=' + $rep.RamGb + ' want=' + $rep.WantMb + ' usage=' + $rep.UsageMb)
        return (New-PfResult -Reason 'pending_reboot' -AbortBoot $true -Report $rep -Detail 'settings_ok usage_old')
    }
    if ($dec.Reason -eq 'live_mismatch') {
        $d = 'want=' + $rep.WantMb + ' usage=' + $rep.UsageMb + ' ini=' + $rep.CInitialMb + ' max=' + $rep.CMaximumMb + ' after_reboot_no_loop'
        Write-PfTune ('PAGEFILE skip=live_mismatch ' + $d)
        return (New-PfResult -Reason 'live_mismatch' -Report $rep -Detail $d)
    }
    if ($dec.Reason -eq 'apply_cap') {
        Write-PfTune ('PAGEFILE skip=apply_cap count=' + $applyCount + ' want=' + $rep.WantMb)
        return (New-PfResult -Reason 'apply_cap' -Report $rep -Detail ('count=' + $applyCount))
    }
    if ($dec.Reason -eq 'no_disk') {
        $needGb = [math]::Round(([double]$rep.GrowBytes) / 1GB, 1)
        $freeGb = [math]::Round(([double]$rep.CFreeBytes) / 1GB, 1)
        $afterGb = [math]::Round(([double]$rep.CFreeAfterBytes) / 1GB, 1)
        $d = 'needGrowGb=' + $needGb + ' freeGb=' + $freeGb + ' afterGb=' + $afterGb + ' remainMinGb=30 currentPfMb=' + $rep.CurrentPfMb
        Write-PfTune ('PAGEFILE skip=no_disk ' + $d)
        return (New-PfResult -Reason 'no_disk' -Report $rep -Detail $d)
    }
    if ($dec.Reason -eq 'no_admin') {
        if (-not (Test-PfSystem)) {
            Write-PfTune ('PAGEFILE bounce=ConvenienteNetBoot SYSTEM wantMb=' + $rep.WantMb + ' ramGb=' + $rep.RamGb + ' src=' + $rep.RamSource)
            $sys = Invoke-PfViaSystemTask
            if ($sys) {
                $why = [string]$sys.reason
                Write-PfTune ('PAGEFILE bounce_result reason=' + $why + ' abort=' + $sys.abortBoot)
                if ($why -eq 'applied_reboot' -or $why -eq 'pending_reboot' -or [bool]$sys.abortBoot) {
                    $after = Get-ConvenientePagefileCommitReport
                    return (New-PfResult -Reason 'applied_reboot' -AbortBoot $true -Report $after -Detail 'system_task_ok')
                }
                if ($why -eq 'already_ok') {
                    $after = Get-ConvenientePagefileCommitReport
                    return (New-PfResult -Reason 'already_ok' -Report $after -Detail 'system_task_live')
                }
            } else {
                Write-PfTune 'PAGEFILE bounce_fail ConvenienteNetBoot'
            }
        }
        Write-PfTune ('PAGEFILE skip=no_admin wantMb=' + $rep.WantMb + ' ini=' + $rep.CInitialMb + ' max=' + $rep.CMaximumMb + ' ramGb=' + $rep.RamGb)
        return (New-PfResult -Reason 'no_admin' -Report $rep -Detail 'HKLM pagefile: Iniciar pede ConvenienteNetBoot SYSTEM; sem a tarefa, nao grava')
    }
    if ($dec.Reason -eq 'dryrun') {
        Write-PfTune ('PAGEFILE skip=dryrun wantMb=' + $rep.WantMb)
        return (New-PfResult -Reason 'dryrun' -Report $rep -Detail 'nao gravou')
    }
    if ($rep.Live) {
        Write-PfTune ('PAGEFILE ok live guard ramGb=' + $rep.RamGb + ' mb=' + $rep.WantMb)
        return (New-PfResult -Reason 'already_ok' -Report $rep -Detail 'live_guard')
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
    $wrote = [bool]($after.Configured -or ($regOk -and $after.RegExact))
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

function Invoke-PfSelfTest {
    $script:PfSelfFailed = 0
    function Assert-PfDec([string]$Name, $Got, [string]$WantReason, [bool]$WantAbort) {
        $ok = (([string]$Got.Reason -eq $WantReason) -and ([bool]$Got.AbortBoot -eq $WantAbort))
        if ($ok) {
            Write-Host ('SELFTEST OK  ' + $Name)
        } else {
            $script:PfSelfFailed++
            Write-Host ('SELFTEST FAIL ' + $Name + ' got=' + $Got.Reason + ' abort=' + $Got.AbortBoot + ' want=' + $WantReason + ' wantAbort=' + $WantAbort)
        }
    }
    function Assert-PfTrue([string]$Name, [bool]$Ok, [string]$Extra = '') {
        if ($Ok) {
            Write-Host ('SELFTEST OK  ' + $Name)
        } else {
            $script:PfSelfFailed++
            Write-Host ('SELFTEST FAIL ' + $Name + $(if ($Extra) { ' :: ' + $Extra } else { '' }))
        }
    }

    $gb80 = [int64]80GB
    $gb4_5 = [int64](4.5 * 1GB)
    $gb50 = [int64]50GB
    $gb40 = [int64]40GB

    $live = New-PfFakeReport -Ini 16384 -Max 16384 -UsageMb 16384 -FreeBytes $gb80
    Assert-PfDec 'already_ok_live' (Resolve-PfDecision -Report $live -DoApply $true) 'already_ok' $false

    $ramPick = Get-PfRamPick -Cands @(
        [pscustomobject]@{ Bytes = ([int64]32GB); Source = 'Win32_PhysicalMemory' },
        [pscustomobject]@{ Bytes = ([int64]65442 * 1MB); Source = 'Win32_OperatingSystem' }
    )
    Assert-PfTrue 'ram_max_picks_64_not_32' ([int]$ramPick.Gb -eq 64) ('gb=' + $ramPick.Gb + ' src=' + $ramPick.Source)

    $ramPickDimm = Get-PfRamPick -Cands @(
        [pscustomobject]@{ Bytes = ([int64]64GB); Source = 'Win32_PhysicalMemory' },
        [pscustomobject]@{ Bytes = ([int64]32GB); Source = 'Win32_OperatingSystem' }
    )
    Assert-PfTrue 'ram_max_picks_dimm_64' ([int]$ramPickDimm.Gb -eq 64) ('gb=' + $ramPickDimm.Gb + ' src=' + $ramPickDimm.Source)

    $lowDiskLive = New-PfFakeReport -Ini 16384 -Max 16384 -UsageMb 16384 -FreeBytes ([int64]5GB) -Admin $true
    Assert-PfTrue 'live_then_ssd_below_30_diskok_false' (-not [bool]$lowDiskLive.DiskOk)
    Assert-PfDec 'live_then_ssd_below_30_never_unconfig' (Resolve-PfDecision -Report $lowDiskLive -DoApply $true) 'already_ok' $false

    $slack = New-PfFakeReport -Ini 16384 -Max 16384 -UsageMb 16320 -FreeBytes $gb80
    Assert-PfDec 'already_ok_slack64' (Resolve-PfDecision -Report $slack -DoApply $true) 'already_ok' $false

    $custom = New-PfFakeReport -Ini 128 -Max 8192 -UsageMb 191 -FreeBytes $gb80 -Admin $true
    Assert-PfTrue 'custom_range_not_live' (-not $custom.Live -and -not $custom.Configured -and $custom.DiskOk)
    Assert-PfDec 'custom_range_applies' (Resolve-PfDecision -Report $custom -DoApply $true) 'should_apply' $false

    $range2g = New-PfFakeReport -Ini 2048 -Max 4096 -UsageMb 2048 -FreeBytes $gb80 -Admin $true
    Assert-PfTrue 'fixed_2_4gb_not_11' (-not $range2g.Live -and -not $range2g.Configured)
    Assert-PfDec 'fixed_2_4gb_applies' (Resolve-PfDecision -Report $range2g -DoApply $true) 'should_apply' $false

    $noDisk = New-PfFakeReport -Ini 128 -Max 8192 -UsageMb 191 -FreeBytes $gb4_5 -Admin $true
    Assert-PfTrue 'tiny_c_not_diskok' (-not $noDisk.DiskOk)
    Assert-PfDec 'tiny_c_skip' (Resolve-PfDecision -Report $noDisk -DoApply $true) 'no_disk' $false

    $noAdm = New-PfFakeReport -Ini 128 -Max 8192 -UsageMb 191 -FreeBytes $gb80 -Admin $false
    Assert-PfDec 'space_but_no_admin' (Resolve-PfDecision -Report $noAdm -DoApply $true) 'no_admin' $false

    $pending = New-PfFakeReport -Ini 16384 -Max 16384 -UsageMb 191 -FreeBytes $gb80 -Admin $true
    Assert-PfTrue 'pending_configured' ([bool]$pending.Configured -and [bool]$pending.PendingReboot -and -not $pending.Live)
    Assert-PfDec 'pending_same_boot' (Resolve-PfDecision -Report $pending -RebootedSinceApply $false -DoApply $true) 'pending_reboot' $true

    Assert-PfDec 'mismatch_after_reboot' (Resolve-PfDecision -Report $pending -RebootedSinceApply $true -DoApply $true) 'live_mismatch' $false

    $auto = New-PfFakeReport -AutoOff $false -Managed $true -Ini 0 -Max 0 -UsageMb 4096 -FreeBytes $gb80 -Admin $true
    Assert-PfTrue 'auto_not_configured' (-not $auto.Configured -and -not $auto.Live)
    Assert-PfDec 'auto_applies' (Resolve-PfDecision -Report $auto -DoApply $true) 'should_apply' $false

    $usageOkRegWrong = New-PfFakeReport -Ini 128 -Max 8192 -UsageMb 16384 -FreeBytes $gb80 -Admin $true
    Assert-PfTrue 'usage_alone_not_ok' (-not $usageOkRegWrong.Live -and -not $usageOkRegWrong.Configured)
    Assert-PfDec 'usage_alone_must_pin' (Resolve-PfDecision -Report $usageOkRegWrong -DoApply $true) 'should_apply' $false

    $revert = New-PfFakeReport -Ini 128 -Max 8192 -UsageMb 191 -FreeBytes $gb80 -Admin $true
    Assert-PfDec 'retry_after_windows_revert' (Resolve-PfDecision -Report $revert -RebootedSinceApply $true -ApplyCount 1 -DoApply $true) 'should_apply' $false
    Assert-PfDec 'cap_after_two_applies' (Resolve-PfDecision -Report $revert -RebootedSinceApply $true -ApplyCount 2 -DoApply $true) 'apply_cap' $false

    Assert-PfDec 'dryrun_does_not_write' (Resolve-PfDecision -Report $custom -DoApply $true -DryRunFlag $true) 'dryrun' $false

    $deadRam = New-PfFakeReport -RamOk $false -WantMb 0 -Ini 128 -Max 8192 -UsageMb 191 -FreeBytes $gb80
    Assert-PfDec 'no_ram' (Resolve-PfDecision -Report $deadRam -DoApply $true) 'no_ram' $false

    $dOk = Get-PfDiskMath -WantMb 16384 -CurrentPfMb 4096 -FreeBytes $gb50
    Assert-PfTrue 'remainder_50_minus_12_ok' ([bool]$dOk.DiskOk) ('after=' + $dOk.FreeAfterBytes)
    $dNo = Get-PfDiskMath -WantMb 16384 -CurrentPfMb 4096 -FreeBytes $gb40
    Assert-PfTrue 'remainder_40_minus_12_skip' (-not [bool]$dNo.DiskOk) ('after=' + $dNo.FreeAfterBytes)

    $exactFree = ([int64]16384 * 1MB) + [int64]30GB
    $dExact = Get-PfDiskMath -WantMb 16384 -CurrentPfMb 0 -FreeBytes $exactFree
    Assert-PfTrue 'remainder_exactly_30_ok' ([bool]$dExact.DiskOk)
    $dShort = Get-PfDiskMath -WantMb 16384 -CurrentPfMb 0 -FreeBytes ($exactFree - [int64]1)
    Assert-PfTrue 'remainder_30_minus_1_skip' (-not [bool]$dShort.DiskOk)

    $shrink = Get-PfDiskMath -WantMb 16384 -CurrentPfMb 32768 -FreeBytes ([int64]20GB)
    Assert-PfTrue 'shrink_credits_disk' ([bool]$shrink.DiskOk)

    if ($script:PfSelfFailed -gt 0) {
        Write-Host ('SELFTEST_FAILED ' + $script:PfSelfFailed)
        return 1
    }
    Write-Host 'SELFTEST_OK'
    return 0
}

$script:ConvenientePagefileDotSourced = ($MyInvocation.InvocationName -eq '.')
if (-not $script:ConvenientePagefileDotSourced) {
    if ($SelfTest) {
        $stCode = Invoke-PfSelfTest
        exit $stCode
    }
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
