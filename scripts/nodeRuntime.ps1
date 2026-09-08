Set-StrictMode -Version Latest

$script:ConvenienteNodeRuntimeManifestCache = $null

function Write-ConvenienteNodeRuntimeEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Event,
        [hashtable]$Data
    )

    try {
        $repoRoot = Get-ConvenienteRepoRoot
        $dados = Join-Path $repoRoot 'dados'
        $path = Join-Path $dados 'node_runtime_events.jsonl'
        New-Item -ItemType Directory -Path $dados -Force | Out-Null
        $body = [ordered]@{
            ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            iso = (Get-Date).ToUniversalTime().ToString('o')
            event = [string]$Event
        }
        if ($Data) {
            foreach ($k in $Data.Keys) {
                $body[$k] = $Data[$k]
            }
        }
        Add-Content -LiteralPath $path -Value ($body | ConvertTo-Json -Compress -Depth 6) -Encoding UTF8
    } catch {}
}

function Write-ConvenienteNodeRuntimeState {
    param(
        [Parameter(Mandatory = $true)][hashtable]$State
    )

    try {
        $repoRoot = Get-ConvenienteRepoRoot
        $dados = Join-Path $repoRoot 'dados'
        $path = Join-Path $dados 'node_runtime_last.json'
        New-Item -ItemType Directory -Path $dados -Force | Out-Null
        $body = [ordered]@{
            ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            iso = (Get-Date).ToUniversalTime().ToString('o')
        }
        foreach ($k in $State.Keys) {
            $body[$k] = $State[$k]
        }
        $body | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8
    } catch {}
}

function Get-ConvenienteRepoRoot {
    return (Split-Path -Parent $PSScriptRoot)
}

function Get-ConvenienteNodeRuntimeManifest {
    if ($script:ConvenienteNodeRuntimeManifestCache) {
        return $script:ConvenienteNodeRuntimeManifestCache
    }

    $manifestPath = Join-Path $PSScriptRoot 'nodeRuntimeManifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "node_runtime_manifest_missing: $manifestPath"
    }

    $raw = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $repoRoot = Get-ConvenienteRepoRoot
    $zipPath = Join-Path $repoRoot ([string]$raw.repoZipRel)
    $extractRoot = Join-Path $repoRoot ([string]$raw.extractRootRel)
    $distDir = Join-Path $extractRoot ([string]$raw.distName)
    $nodeExe = Join-Path $distDir ([string]$raw.nodeExeRel)
    $npmCmd = Join-Path $distDir ([string]$raw.npmCmdRel)

    $script:ConvenienteNodeRuntimeManifestCache = [ordered]@{
        Version      = [string]$raw.version
        WantedTag    = if ([string]$raw.version -match '^v') { [string]$raw.version } else { 'v' + [string]$raw.version }
        DistName     = [string]$raw.distName
        RepoZipRel   = [string]$raw.repoZipRel
        ExtractRoot  = $extractRoot
        DistDir      = $distDir
        NodeExe      = $nodeExe
        NpmCmd       = $npmCmd
        ZipPath      = $zipPath
        ZipSha256    = ([string]$raw.zipSha256).ToLowerInvariant()
        DownloadUrl  = [string]$raw.downloadUrl
        ManifestPath = $manifestPath
    }
    return $script:ConvenienteNodeRuntimeManifestCache
}

function Test-ConvenienteNodeVersion {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$WantedTag
    )

    if (-not (Test-Path -LiteralPath $NodeExe)) {
        return @{ ok = $false; error = 'node_missing'; version = $null }
    }

    try {
        $out = & $NodeExe -v 2>$null
        $ver = ''
        if ($null -ne $out) {
            $ver = [string](@($out)[0])
        }
        $ver = $ver.Trim()
        if (-not $ver) {
            return @{ ok = $false; error = 'node_version_empty'; version = $null }
        }
        if ($ver -ne $WantedTag) {
            return @{ ok = $false; error = 'node_version_unexpected'; version = $ver }
        }
        return @{ ok = $true; error = $null; version = $ver }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message; version = $null }
    }
}

function Expand-ConvenienteNodeRuntimeZip {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Manifest
    )

    New-Item -ItemType Directory -Path $Manifest.ExtractRoot -Force | Out-Null

    $tempRoot = Join-Path $Manifest.ExtractRoot ('.extract_' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        Expand-Archive -LiteralPath $Manifest.ZipPath -DestinationPath $tempRoot -Force

        $candidateDir = Join-Path $tempRoot $Manifest.DistName
        if (-not (Test-Path -LiteralPath $candidateDir)) {
            $dirs = @(Get-ChildItem -LiteralPath $tempRoot -Directory -ErrorAction SilentlyContinue)
            if ($dirs.Count -eq 1) {
                $candidateDir = $dirs[0].FullName
            }
        }

        if (-not (Test-Path -LiteralPath $candidateDir)) {
            throw "node_extract_missing_dir: $tempRoot"
        }

        if (Test-Path -LiteralPath $Manifest.DistDir) {
            Remove-Item -LiteralPath $Manifest.DistDir -Recurse -Force -ErrorAction Stop
        }

        Move-Item -LiteralPath $candidateDir -Destination $Manifest.DistDir -Force
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-ConvenienteNodeRuntime {
    param(
        [switch]$RequireNpm
    )

    try {
        $manifest = Get-ConvenienteNodeRuntimeManifest
        if (-not (Test-Path -LiteralPath $manifest.ZipPath)) {
            $out = [ordered]@{
                Ok         = $false
                Error      = 'node_zip_missing'
                ZipPath    = $manifest.ZipPath
                WantedTag  = $manifest.WantedTag
                DownloadUrl = $manifest.DownloadUrl
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_fail' -Data $out
            return $out
        }

        $zipHash = ((Get-FileHash -LiteralPath $manifest.ZipPath -Algorithm SHA256).Hash).ToLowerInvariant()
        if ($zipHash -ne $manifest.ZipSha256) {
            $out = [ordered]@{
                Ok          = $false
                Error       = 'node_zip_sha256_mismatch'
                ZipPath     = $manifest.ZipPath
                ZipSha256   = $zipHash
                ExpectedSha = $manifest.ZipSha256
                WantedTag   = $manifest.WantedTag
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_fail' -Data $out
            return $out
        }

        $existing = Test-ConvenienteNodeVersion -NodeExe $manifest.NodeExe -WantedTag $manifest.WantedTag
        if ($existing.ok -and ((-not $RequireNpm) -or (Test-Path -LiteralPath $manifest.NpmCmd))) {
            $out = [ordered]@{
                Ok        = $true
                Source    = 'existing'
                WantedTag = $manifest.WantedTag
                NodeExe   = $manifest.NodeExe
                NpmCmd    = $manifest.NpmCmd
                DistDir   = $manifest.DistDir
                ZipPath   = $manifest.ZipPath
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_ok' -Data $out
            return $out
        }

        Expand-ConvenienteNodeRuntimeZip -Manifest $manifest

        $check = Test-ConvenienteNodeVersion -NodeExe $manifest.NodeExe -WantedTag $manifest.WantedTag
        if (-not $check.ok) {
            $out = [ordered]@{
                Ok        = $false
                Error     = 'node_extract_invalid'
                Detail    = $check.error
                Version   = $check.version
                WantedTag = $manifest.WantedTag
                NodeExe   = $manifest.NodeExe
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_fail' -Data $out
            return $out
        }

        if ($RequireNpm -and -not (Test-Path -LiteralPath $manifest.NpmCmd)) {
            $out = [ordered]@{
                Ok        = $false
                Error     = 'npm_cmd_missing'
                WantedTag = $manifest.WantedTag
                NodeExe   = $manifest.NodeExe
                NpmCmd    = $manifest.NpmCmd
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_fail' -Data $out
            return $out
        }

        $out = [ordered]@{
            Ok        = $true
            Source    = 'extracted'
            WantedTag = $manifest.WantedTag
            NodeExe   = $manifest.NodeExe
            NpmCmd    = $manifest.NpmCmd
            DistDir   = $manifest.DistDir
            ZipPath   = $manifest.ZipPath
        }
        Write-ConvenienteNodeRuntimeState $out
        Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_ok' -Data $out
        return $out
    } catch {
        $out = [ordered]@{
            Ok    = $false
            Error = $_.Exception.Message
        }
        Write-ConvenienteNodeRuntimeState $out
        Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_exception' -Data $out
        return $out
    }
}

function Repair-ConvenienteNodeRuntimeZip {
    param(
        [switch]$Force
    )

    try {
        $manifest = Get-ConvenienteNodeRuntimeManifest
        $zipDir = Split-Path -Parent $manifest.ZipPath
        New-Item -ItemType Directory -Path $zipDir -Force | Out-Null
        if ((Test-Path -LiteralPath $manifest.ZipPath) -and (-not $Force)) {
            $out = [ordered]@{
                Ok       = $false
                Error    = 'node_zip_already_present'
                ZipPath  = $manifest.ZipPath
                WantedTag = $manifest.WantedTag
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_zip_repair_skip' -Data $out
            return $out
        }

        $tmp = $manifest.ZipPath + '.tmp'
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Invoke-WebRequest -UseBasicParsing $manifest.DownloadUrl -OutFile $tmp
        $hash = ((Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash).ToLowerInvariant()
        if ($hash -ne $manifest.ZipSha256) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            $out = [ordered]@{
                Ok          = $false
                Error       = 'node_zip_repair_sha256_mismatch'
                ZipPath     = $manifest.ZipPath
                ZipSha256   = $hash
                ExpectedSha = $manifest.ZipSha256
                WantedTag   = $manifest.WantedTag
                DownloadUrl = $manifest.DownloadUrl
            }
            Write-ConvenienteNodeRuntimeState $out
            Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_zip_repair_fail' -Data $out
            return $out
        }

        Move-Item -LiteralPath $tmp -Destination $manifest.ZipPath -Force
        $out = [ordered]@{
            Ok         = $true
            ZipPath    = $manifest.ZipPath
            ZipSha256  = $hash
            WantedTag  = $manifest.WantedTag
            DownloadUrl = $manifest.DownloadUrl
        }
        Write-ConvenienteNodeRuntimeState $out
        Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_zip_repaired' -Data $out
        return $out
    } catch {
        $out = [ordered]@{
            Ok    = $false
            Error = $_.Exception.Message
        }
        Write-ConvenienteNodeRuntimeState $out
        Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_zip_repair_exception' -Data $out
        return $out
    }
}

function Get-ConvenienteNodeExe {
    $result = Ensure-ConvenienteNodeRuntime
    if (-not $result.Ok) {
        throw ("node_runtime_fail: " + [string]$result.Error)
    }
    return [string]$result.NodeExe
}

function Get-ConvenienteNpmCmd {
    $result = Ensure-ConvenienteNodeRuntime -RequireNpm
    if (-not $result.Ok) {
        throw ("node_runtime_fail: " + [string]$result.Error)
    }
    return [string]$result.NpmCmd
}
