# Host Windows do Conveniente. Nao mexe em Robe/Virtus/frota.
# Sem UAC. Sem Wait no Iniciar. Falha local nunca impede o Node.
# WerSvc fica Manual e LIGADO. Disabled apaga dump. Stop tambem. FastFail 0xC0000409 precisa do servico de pe.
# Chrome/node so do caminho C:\conveniente. Poll 5s (1ms queima CPU).
# Adendo registro: VisualFXSetting=2, MinAnimate=0, Win32PrioritySeparation=24.
# Cada passo grava before/after/motivo em windows_tuning.forensic.jsonl.

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
$ForensicFile = Join-Path $LogDir 'windows_tuning.forensic.jsonl'
$ForensicPrev = Join-Path $LogDir 'windows_tuning.forensic.prev.jsonl'
$HeapBak = Join-Path $LogDir 'windows_subsystem_windows.bak'
$MutexName = 'Local\ConvenienteWinTuningWatch'
$PollSec = 5
$InteractiveHeapMinKb = 30720
$InteractiveHeapMaxKb = 65536
$UltimateGuid = 'e9a42b02-d5df-448d-aa00-03f14749eb61'
$HighPerfGuid = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$script:RunId = [guid]::NewGuid().ToString('N').Substring(0, 12)

function Test-IsAdmin {
    try {
        $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Ensure-TuneDir {
    if (-not (Test-Path -LiteralPath $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
}

function Rotate-TuneFile([string]$Path, [string]$PrevPath, [int]$MaxBytes) {
    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
        if ($item -and $item.Length -gt $MaxBytes) {
            Remove-Item -LiteralPath $PrevPath -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $Path -Destination $PrevPath -Force
        }
    } catch {}
}

function Write-TuneLog([string]$Line) {
    try {
        Ensure-TuneDir
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $LogFile -Value "$ts $Line" -Encoding ASCII
        Rotate-TuneFile $LogFile (Join-Path $LogDir 'windows_tuning.prev.log') 1500000
    } catch {}
}

function Write-Forensic {
    param([hashtable]$Obj)
    try {
        Ensure-TuneDir
        Rotate-TuneFile $ForensicFile $ForensicPrev 2097152
        $now = Get-Date
        $rec = [ordered]@{
            ts = [int64]([DateTimeOffset]$now).ToUnixTimeMilliseconds()
            iso = $now.ToString('o')
            event = ''
            step = ''
            ok = $null
            skipped = $null
            detail = ''
            reason = ''
            before = $null
            after = $null
            want = $null
            hive = $null
            path = $null
            name = $null
            error = $null
            options = $null
            dryRun = [bool]$DryRun
            admin = [bool](Test-IsAdmin)
            host = $env:COMPUTERNAME
            user = $env:USERNAME
            runId = $script:RunId
            pid = $PID
        }
        if ($null -ne $Obj) {
            foreach ($k in $Obj.Keys) { $rec[$k] = $Obj[$k] }
        }
        Add-Content -LiteralPath $ForensicFile -Value ($rec | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
    } catch {}
}

function Save-TuneState($Obj) {
    try {
        Ensure-TuneDir
        ($Obj | ConvertTo-Json -Compress -Depth 8) | Set-Content -LiteralPath $StateFile -Encoding UTF8
    } catch {}
}

function Get-OsSnapshot {
    $snap = [ordered]@{
        computer = $env:COMPUTERNAME
        user = $env:USERNAME
        domain = $env:USERDOMAIN
        session = $env:SESSIONNAME
        arch = $env:PROCESSOR_ARCHITECTURE
        osCaption = ''
        osVersion = ''
        osBuild = ''
        lastBoot = ''
        totalRamMb = 0
        freeRamMb = 0
        powerScheme = ''
    }
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $snap.osCaption = [string]$os.Caption
        $snap.osVersion = [string]$os.Version
        $snap.osBuild = [string]$os.BuildNumber
        if ($os.LastBootUpTime) { $snap.lastBoot = ([datetime]$os.LastBootUpTime).ToString('o') }
        $snap.totalRamMb = [int]([double]$os.TotalVisibleMemorySize / 1024)
        $snap.freeRamMb = [int]([double]$os.FreePhysicalMemory / 1024)
    } catch {}
    try {
        $out = & powercfg.exe /getactivescheme 2>$null
        if ($out) { $snap.powerScheme = ([string]$out).Trim() }
    } catch {}
    return [pscustomobject]$snap
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
    $row = [ordered]@{
        name = $Name
        ok = $false
        skipped = $false
        detail = ''
        before = $null
        after = $null
        want = $null
        reason = $null
        options = $null
        error = $null
        hive = $null
        path = $null
        nameKey = $null
    }
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
        $row.error = [string]$_.Exception.Message
    }
    if (-not $row.detail) { $row.detail = '' }
    Write-TuneLog ('STEP ' + $row.name + ' ok=' + $row.ok + ' skip=' + $row.skipped + ' before=' + $row.before + ' after=' + $row.after + ' want=' + $row.want + ' ' + $row.detail)
    Write-Forensic @{
        event = 'step'
        step = [string]$row.name
        ok = $row.ok
        skipped = $row.skipped
        detail = [string]$row.detail
        reason = $row.reason
        before = $row.before
        after = $row.after
        want = $row.want
        options = $row.options
        error = $row.error
        hive = $row.hive
        path = $row.path
        name = $row.nameKey
    }
    return [pscustomobject]$row
}

function Get-RegRaw([string]$Path, [string]$Name) {
    $out = @{ hiveExists = $false; value = $null; kind = $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $out }
    try {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        $out.hiveExists = $true
        $out.value = $item.GetValue($Name, $null)
        try { $out.kind = [string]$item.GetValueKind($Name) } catch { $out.kind = $null }
    } catch {}
    return $out
}

function Set-RegWanted {
    param(
        [string]$Path,
        [string]$Name,
        $Want,
        [ValidateSet('DWord','String')]$Type,
        [switch]$NeedAdmin,
        [string]$Why,
        [object]$Known
    )
    $cur = Get-RegRaw $Path $Name
    $before = if ($null -eq $cur.value) { 'null' } else { [string]$cur.value }
    $wantText = [string]$Want
    $opts = @(
        'DryRun nao escreve',
        'readback depois do Set-ItemProperty',
        'ACL/politica de dominio pode recusar'
    )
    if ($Known) { $opts += $Known }
    if ($NeedAdmin -and -not (Test-IsAdmin)) {
        return @{
            ok = $true
            skipped = $true
            detail = 'sem_admin hive HKLM nao escreve'
            before = $before
            after = $before
            want = $wantText
            reason = $Why
            options = @('Setup porteiro -Apply elevado', 'pular no Iniciar sem UAC')
            hive = $Path
            path = $Path
            nameKey = $Name
        }
    }
    $same = $false
    if ($Type -eq 'DWord') {
        try { $same = ($null -ne $cur.value -and [int64]$cur.value -eq [int64]$Want) } catch { $same = $false }
    } else {
        $same = ($null -ne $cur.value -and [string]$cur.value -eq [string]$Want)
    }
    if ($same) {
        return @{
            ok = $true
            skipped = $true
            detail = ('already=' + $before + ' kind=' + $cur.kind)
            before = $before
            after = $before
            want = $wantText
            reason = $Why
            options = $opts
            hive = $Path
            path = $Path
            nameKey = $Name
        }
    }
    if ($DryRun) {
        return @{
            ok = $true
            skipped = $true
            detail = 'dryrun'
            before = $before
            after = $before
            want = $wantText
            reason = $Why
            options = $opts
            hive = $Path
            path = $Path
            nameKey = $Name
        }
    }
    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            New-Item -Path $Path -Force | Out-Null
        }
        Set-ItemProperty -LiteralPath $Path -Name $Name -Value $Want -Type $Type -Force -ErrorAction Stop
        $afterObj = Get-RegRaw $Path $Name
        $after = if ($null -eq $afterObj.value) { 'null' } else { [string]$afterObj.value }
        $okNow = $false
        if ($Type -eq 'DWord') {
            try { $okNow = ($null -ne $afterObj.value -and [int64]$afterObj.value -eq [int64]$Want) } catch { $okNow = $false }
        } else {
            $okNow = ([string]$afterObj.value -eq [string]$Want)
        }
        return @{
            ok = [bool]$okNow
            skipped = $false
            detail = ('kind ' + $cur.kind + ' -> ' + $Type + ' readback=' + $after)
            before = $before
            after = $after
            want = $wantText
            reason = $Why
            options = $opts
            error = $(if ($okNow) { $null } else { 'readback_mismatch' })
            hive = $Path
            path = $Path
            nameKey = $Name
        }
    } catch {
        return @{
            ok = $false
            skipped = $false
            detail = [string]$_.Exception.Message
            before = $before
            after = $before
            want = $wantText
            reason = $Why
            options = @('ACL da chave', 'politica de dominio', 'tipo REG incompativel', 'chave inexistente e New-Item recusou')
            error = [string]$_.Exception.Message
            hive = $Path
            path = $Path
            nameKey = $Name
        }
    }
}

function Set-VisualFXSetting {
    return (Set-RegWanted -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' -Name 'VisualFXSetting' -Want 2 -Type DWord -Why 'VisualFXSetting=2 e o modo Ajustar para melhor desempenho; HKCU nao precisa admin; sessao atual pode exigir logoff para o DWM aplicar por completo; nao mata explorer')
}

function Set-MinAnimate {
    return (Set-RegWanted -Path 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name 'MinAnimate' -Want '0' -Type String -Why 'Windows guarda MinAnimate como REG_SZ 0/1 (nao DWORD); 0 desliga animacao de minimizar/maximizar; nao mata explorer')
}

function Set-Win32PrioritySeparation {
    $path = 'HKLM:\SYSTEM\CurrentControlSet\Control\PriorityControl'
    $cur = Get-RegRaw $path 'Win32PrioritySeparation'
    Write-Forensic @{
        event = 'priority_backup'
        step = 'reg_win32priority'
        ok = $null
        skipped = $false
        detail = 'valor atual antes de qualquer escrita'
        before = $(if ($null -eq $cur.value) { 'null' } else { [string]$cur.value })
        want = '24'
        hive = $path
        path = $path
        name = 'Win32PrioritySeparation'
        options = @{
            '2' = 'Programs / foreground (comum em workstation)'
            '24' = 'Background services (0x18) alvo deste adendo'
            '26' = 'Programs variante (0x1A)'
            '38' = 'visto em alguns servidores'
        }
        reason = 'backup forense; 24 calibra quantum no perfil Background Services; RDP/desktop pode parecer menos na frente; nao afirma cura de FastFail'
    }
    return (Set-RegWanted -Path $path -Name 'Win32PrioritySeparation' -Want 24 -Type DWord -NeedAdmin -Why 'Win32PrioritySeparation=24 (0x18) perfil Background Services; fatias longas/estaveis para processos de fundo; precisa admin; nao afirma cura de FastFail' -Known @('2=Programs', '24=Background 0x18', '26=Programs 0x1A'))
}

function Set-WerSvcReady {
    $svc = Get-Service -Name WerSvc -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        return @{ ok = $true; skipped = $true; detail = 'servico_ausente'; before = 'ausente'; after = 'ausente'; want = 'Running/Manual'; reason = 'WerSvc nao existe nesta SKU' }
    }
    $before = ($svc.Status.ToString() + '/' + $svc.StartType.ToString())
    if ($DryRun) {
        return @{ ok = $true; skipped = $true; detail = 'dryrun'; before = $before; after = $before; want = 'Running/Manual'; reason = 'Manual + ligado; dump FastFail precisa do servico de pe' }
    }
    if (-not (Test-IsAdmin)) {
        return @{ ok = $true; skipped = $true; detail = 'sem_admin'; before = $before; after = $before; want = 'Running/Manual'; reason = 'Start-Service WerSvc precisa admin; porteiro SYSTEM liga' }
    }
    try {
        Set-Service -Name WerSvc -StartupType Manual -ErrorAction Stop
        if ((Get-Service -Name WerSvc).Status -ne 'Running') {
            Start-Service -Name WerSvc -ErrorAction Stop
        }
        $afterSvc = Get-Service -Name WerSvc -ErrorAction Stop
        $after = ($afterSvc.Status.ToString() + '/' + $afterSvc.StartType.ToString())
        return @{
            ok = ($afterSvc.Status -eq 'Running')
            skipped = $false
            detail = ('state=' + $afterSvc.Status + ' start=' + $afterSvc.StartType)
            before = $before
            after = $after
            want = 'Running/Manual'
            reason = 'Nunca Disabled. Nunca Stop. Dump do node precisa do WerSvc de pe'
        }
    } catch {
        return @{ ok = $false; skipped = $false; detail = $_.Exception.Message; before = $before; after = $before; want = 'Running/Manual'; reason = 'WerSvc recusou Start' }
    }
}

function Set-NodeLocalDumps {
    $folder = 'C:\conveniente\dados\crash_dumps'
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe'
    $before = 'ausente'
    try {
        if (Test-Path -LiteralPath $key) {
            $cur = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            $before = [string]$cur.DumpFolder + '/' + [string]$cur.DumpType
        }
    } catch {}
    if ($DryRun) {
        return @{ ok = $true; skipped = $true; detail = 'dryrun'; before = $before; after = $before; want = $folder; reason = 'LocalDumps node.exe mini-dump' }
    }
    if (-not (Test-IsAdmin)) {
        return @{ ok = $true; skipped = $true; detail = 'sem_admin'; before = $before; after = $before; want = $folder; reason = 'HKLM LocalDumps precisa admin; NetBoot SYSTEM arma' }
    }
    try {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
        New-ItemProperty -Path $key -Name DumpFolder -Value $folder -PropertyType ExpandString -Force | Out-Null
        New-ItemProperty -Path $key -Name DumpType -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name DumpCount -Value 8 -PropertyType DWord -Force | Out-Null
        return @{ ok = $true; skipped = $false; detail = 'armed'; before = $before; after = $folder + '/1'; want = $folder; reason = 'mini-dump FastFail node.exe' }
    } catch {
        return @{ ok = $false; skipped = $false; detail = $_.Exception.Message; before = $before; after = $before; want = $folder; reason = 'LocalDumps recusou' }
    }
}

function Set-HostServiceMitigated([string]$Name, [ValidateSet('Disabled','Manual')]$Startup) {
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        return @{
            ok = $true
            skipped = $true
            detail = 'servico_ausente'
            before = 'ausente'
            after = 'ausente'
            want = $Startup
            reason = 'Get-Service retornou null neste Windows'
            options = @('skip', 'nome diferente nesta SKU')
        }
    }
    $before = ($svc.Status.ToString() + '/' + $svc.StartType.ToString())
    if ($DryRun) {
        return @{ ok = $true; skipped = $true; detail = 'dryrun'; before = $before; after = $before; want = $Startup }
    }
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    }
    Set-Service -Name $Name -StartupType $Startup -ErrorAction Stop
    $afterSvc = Get-Service -Name $Name -ErrorAction Stop
    $after = ($afterSvc.Status.ToString() + '/' + $afterSvc.StartType.ToString())
    return @{
        ok = ($afterSvc.StartType.ToString() -eq $Startup)
        detail = ('state=' + $afterSvc.Status + ' start=' + $afterSvc.StartType)
        before = $before
        after = $after
        want = $Startup
    }
}

function Set-PowerPlanMax {
    $before = Get-ActiveSchemeGuid
    if ($DryRun) {
        return @{
            ok = $true
            skipped = $true
            detail = 'dryrun'
            before = $before
            after = $before
            want = $UltimateGuid
            reason = 'Ultimate se o GUID existir; senao High Performance'
            options = @($UltimateGuid, $HighPerfGuid)
        }
    }
    & powercfg.exe -duplicatescheme $UltimateGuid 1>$null 2>$null
    & powercfg.exe /setactive $UltimateGuid 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        & powercfg.exe /setactive $HighPerfGuid 1>$null 2>$null
    }
    $guid = Get-ActiveSchemeGuid
    if (-not $guid) { return @{ ok = $false; detail = 'scheme_unknown'; before = $before; want = $UltimateGuid } }
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
    return @{
        ok = $true
        detail = ('scheme=' + $guid)
        before = $before
        after = $guid
        want = $UltimateGuid
        reason = 'Ultimate se aceito; High Performance se Ultimate recusar; disco/standby/hibernate 0; PROCTHROTTLE 100'
        options = @($UltimateGuid, $HighPerfGuid)
    }
}

function Set-DesktopHeapIfNeeded {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\SubSystems'
    $raw = [string](Get-ItemProperty -LiteralPath $key -Name Windows -ErrorAction Stop).Windows
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @{
            ok = $false
            detail = 'windows_value_empty'
            reason = 'nao reescreve a string Windows no escuro'
            options = @('inspecionar no host', 'nao inventar SharedSection')
        }
    }
    if ($raw -notmatch 'SharedSection=(\d+),(\d+),(\d+)') {
        return @{ ok = $false; skipped = $true; detail = 'sharedsection_pattern_absent'; before = $raw }
    }
    $a = [int]$Matches[1]
    $b = [int]$Matches[2]
    $c = [int]$Matches[3]
    $targetB = $b
    if ($targetB -lt $InteractiveHeapMinKb) { $targetB = $InteractiveHeapMinKb }
    if ($targetB -gt $InteractiveHeapMaxKb) { $targetB = $InteractiveHeapMaxKb }
    $before = ($a.ToString() + ',' + $b.ToString() + ',' + $c.ToString())
    $want = ($a.ToString() + ',' + $targetB.ToString() + ',' + $c.ToString())
    if ($b -ge $targetB) {
        return @{
            ok = $true
            skipped = $true
            detail = ('already=' + $a + ',' + $b + ',' + $c)
            before = $before
            after = $before
            want = $want
            reason = 'so sobe o 2o numero; nunca encolhe'
        }
    }
    if ($DryRun) {
        return @{ ok = $true; skipped = $true; detail = ('dryrun ' + $b + '->' + $targetB); before = $before; after = $want; want = $want }
    }
    if (-not (Test-Path -LiteralPath $HeapBak)) {
        Set-Content -LiteralPath $HeapBak -Value $raw -Encoding Unicode
    }
    $new = [regex]::Replace($raw, 'SharedSection=\d+,\d+,\d+', ('SharedSection=' + $a + ',' + $targetB + ',' + $c), 1)
    if ($new -eq $raw -or $new -notmatch 'csrss\.exe' -or $new -notmatch 'SharedSection=') {
        return @{ ok = $false; detail = 'replace_refused'; before = $before; want = $want; reason = 'regex/replace recusou para nao corromper a string Windows' }
    }
    Set-ItemProperty -LiteralPath $key -Name Windows -Value $new -ErrorAction Stop
    $read = [string](Get-ItemProperty -LiteralPath $key -Name Windows -ErrorAction Stop).Windows
    $ok = $read -match ('SharedSection=' + $a + ',' + $targetB + ',' + $c)
    return @{
        ok = [bool]$ok
        detail = ('heap ' + $b + '->' + $targetB + ' reboot_required=1')
        before = $before
        after = ($a.ToString() + ',' + $targetB.ToString() + ',' + $c.ToString())
        want = $want
        reason = 'vale apos reboot; 1o e 3o numeros intactos'
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
        want = 'High so Conveniente+RDP'
        reason = 'sitechatbot/iniciar/manutencao/watcher fora'
    }
}

function Start-WatchLoop {
    $created = $false
    $mutex = $null
    try {
        $mutex = New-Object System.Threading.Mutex($false, $MutexName)
        if (-not $mutex.WaitOne(0, $false)) {
            Write-TuneLog 'WATCH already_running'
            Write-Forensic @{ event = 'watch'; step = 'watch'; detail = 'already_running'; ok = $true; skipped = $true }
            return
        }
        $created = $true
        Write-TuneLog ('WATCH start pollSec=' + $PollSec)
        Write-Forensic @{ event = 'watch'; step = 'watch'; detail = ('start pollSec=' + $PollSec); ok = $true }
        while ($true) {
            try { [void](Apply-ImagePriorities) } catch {}
            Start-Sleep -Seconds $PollSec
        }
    } catch {
        Write-TuneLog ('WATCH fail ' + $_.Exception.Message)
        Write-Forensic @{ event = 'watch'; step = 'watch'; ok = $false; error = [string]$_.Exception.Message; detail = [string]$_.Exception.Message }
    } finally {
        if ($created -and $mutex) {
            try { $mutex.ReleaseMutex() | Out-Null } catch {}
        }
        if ($mutex) { try { $mutex.Dispose() } catch {} }
    }
}

$admin = Test-IsAdmin
$osSnap = Get-OsSnapshot
Write-TuneLog ('BEGIN boot=' + [int][bool]$Boot + ' apply=' + [int][bool]$Apply + ' watch=' + [int][bool]$Watch + ' dry=' + [int][bool]$DryRun + ' admin=' + [int]$admin + ' host=' + $env:COMPUTERNAME + ' run=' + $script:RunId)
Write-Forensic @{
    event = 'begin'
    step = 'apply'
    ok = $null
    detail = 'snapshot do host antes dos passos'
    reason = 'baseline forense'
    options = @{
        os = $osSnap
        visualFx = 'VisualFXSetting DWORD 2'
        minAnimate = 'MinAnimate REG_SZ 0'
        win32Pri = 'Win32PrioritySeparation DWORD 24'
        werSvc = 'Manual nunca Disabled'
        heap = 'so sobe 2o SharedSection 30720-65536'
    }
}

$steps = @()
if ($Apply) {
    if ($admin) {
        $steps += Invoke-Step 'diagtrack' { Set-HostServiceMitigated 'DiagTrack' 'Disabled' }
        $steps += Invoke-Step 'sysmain' { Set-HostServiceMitigated 'SysMain' 'Disabled' }
        $steps += Invoke-Step 'wersvc' { Set-WerSvcReady }
        $steps += Invoke-Step 'node_localdumps' { Set-NodeLocalDumps }
        $steps += Invoke-Step 'power' { Set-PowerPlanMax }
        $steps += Invoke-Step 'desktop_heap' { Set-DesktopHeapIfNeeded }
    } else {
        $steps += Invoke-Step 'admin_gate' { @{ ok = $true; skipped = $true; detail = 'sem_admin servicos/energia/heap adiados'; reason = 'Iniciar/porteiro sem UAC'; options = @('Setup -Apply', 'HKCU e prioridade ainda rodam') } }
        $steps += Invoke-Step 'power_best_effort' { Set-PowerPlanMax }
    }
    $steps += Invoke-Step 'reg_visualfx' { Set-VisualFXSetting }
    $steps += Invoke-Step 'reg_minanimate' { Set-MinAnimate }
    $steps += Invoke-Step 'reg_win32priority' { Set-Win32PrioritySeparation }
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
Write-TuneLog ($stamp + ' Windows host tuning. DiagTrack/SysMain mitigados se admin. WerSvc=Running/Manual (dump FastFail). Energia High/Ultimate + disco/hibernar 0. ' + $heapNote + ' Prioridade High: RDP + node Conveniente + chrome Conveniente.')

$adendoNames = @('reg_visualfx', 'reg_minanimate', 'reg_win32priority')
$adendo = @($steps | Where-Object { $adendoNames -contains $_.name })
$adendoFail = @($adendo | Where-Object { $_.ok -ne $true -and $_.skipped -ne $true }).Count
$adendoSkip = @($adendo | Where-Object { $_.skipped -eq $true }).Count
$adendoApplied = @($adendo | Where-Object { $_.ok -eq $true -and $_.skipped -ne $true }).Count
$adendoAlready = @($adendo | Where-Object { $_.ok -eq $true -and $_.skipped -eq $true -and ([string]$_.detail -like 'already=*') }).Count
$adendoOkN = @($adendo | Where-Object { $_.ok -eq $true }).Count
$adendoStamp = '[TUNING_ADENDO_PARTIAL]'
if ($DryRun) {
    $adendoStamp = '[TUNING_ADENDO_DRYRUN]'
    Write-TuneLog ($adendoStamp + ' DryRun: registro nao escrito. VisualFXSetting want=2 MinAnimate want=0 Win32PrioritySeparation want=24.')
} elseif ($adendoFail -eq 0 -and $adendoOkN -eq 3 -and $adendoSkip -eq 0) {
    $adendoStamp = '[TUNING_ADENDO_OK]'
    Write-TuneLog '[TUNING_ADENDO_OK] Efeitos visuais mitigados e Prioridade de Background injetada via Registro com sucesso.'
} elseif ($adendoFail -eq 0 -and $adendoOkN -eq 3 -and ($adendoAlready + $adendoApplied) -eq 3) {
    $adendoStamp = '[TUNING_ADENDO_OK]'
    Write-TuneLog '[TUNING_ADENDO_OK] Efeitos visuais mitigados e Prioridade de Background injetada via Registro com sucesso.'
} elseif ($adendoFail -eq 0) {
    Write-TuneLog ('[TUNING_ADENDO_PARTIAL] ok=' + $adendoOkN + ' skip=' + $adendoSkip + ' fail=' + $adendoFail + ' applied=' + $adendoApplied + ' (HKLM 24 so com admin)')
} else {
    $adendoStamp = '[TUNING_ADENDO_FAIL]'
    Write-TuneLog ('[TUNING_ADENDO_FAIL] ok=' + $adendoOkN + ' skip=' + $adendoSkip + ' fail=' + $adendoFail)
}
Write-Forensic @{
    event = 'adendo'
    step = 'adendo'
    ok = $(if ($adendoStamp -eq '[TUNING_ADENDO_OK]') { $true } elseif ($adendoStamp -eq '[TUNING_ADENDO_FAIL]') { $false } else { $null })
    skipped = ($adendoStamp -ne '[TUNING_ADENDO_OK]')
    detail = $adendoStamp
    reason = ('ok=' + $adendoOkN + ' skip=' + $adendoSkip + ' fail=' + $adendoFail + ' applied=' + $adendoApplied + ' already=' + $adendoAlready)
    want = 'VisualFXSetting=2; MinAnimate=0; Win32PrioritySeparation=24'
}

Save-TuneState @{
    ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    iso = [DateTime]::UtcNow.ToString('o')
    host = $env:COMPUTERNAME
    runId = $script:RunId
    admin = $admin
    dryRun = [bool]$DryRun
    stamp = $stamp
    adendoStamp = $adendoStamp
    os = $osSnap
    steps = $steps
}

Write-Forensic @{
    event = 'end'
    step = 'apply'
    ok = $okStamp
    detail = $stamp
    reason = $adendoStamp
}

if ($Watch -and -not $DryRun) {
    Start-WatchLoop
}

if ($DryRun) { exit 0 }
exit 0
