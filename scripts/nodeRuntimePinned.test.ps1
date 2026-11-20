$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'nodeRuntime.ps1')
$manifest=Get-ConvenienteNodeRuntimeManifest
$taskNpmRoot=Join-Path ([IO.Path]::GetTempPath()) ('conveniente-pinned-npm-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskNpmRoot -Force | Out-Null
$probe="const fs=require('fs'),cp=require('child_process');fs.writeFileSync('probe.json',JSON.stringify({version:process.version,exec:process.execPath,child:cp.execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim(),npmNode:process.env.npm_node_execpath}));"
[IO.File]::WriteAllText((Join-Path $taskNpmRoot 'probe.cjs'),$probe)
[IO.File]::WriteAllText((Join-Path $taskNpmRoot 'package.json'),'{"name":"pinned-node-lifecycle-fixture","version":"1.0.0","scripts":{"install":"node probe.cjs"}}')
$savedTaskPath=$env:PATH
$savedTaskNpmNode=$env:npm_node_execpath
Push-Location $taskNpmRoot
try {
 $env:PATH=(Join-Path $env:ProgramFiles 'nodejs')+';'+$savedTaskPath
 $beforePath=$env:PATH
 $code=Invoke-ConvenientePinnedNpm -Runtime @{NodeExe=$manifest.NodeExe} -NpmArgs @('install','--offline','--no-fund','--no-audit','--package-lock=false')
 if($code -ne 0){throw 'pinned_install_failed'}
 if($env:PATH -ne $beforePath){throw 'path_not_restored'}
 $proof=Get-Content -LiteralPath 'probe.json' -Raw | ConvertFrom-Json
 if($proof.version -ne 'v20.20.2' -or $proof.exec -ne $manifest.NodeExe -or $proof.child -ne $manifest.NodeExe -or $proof.npmNode -ne $manifest.NodeExe){throw 'pinned_lifecycle_or_child_failed'}
 $code=Invoke-ConvenientePinnedNpm -Runtime @{NodeExe=$manifest.NodeExe} -NpmArgs @('run','missing-script','--offline')
 if($code -eq 0){throw 'failed_npm_accepted'}
 if($env:PATH -ne $beforePath -or $env:npm_node_execpath -ne $savedTaskNpmNode){throw 'failure_env_not_restored'}
 Write-Output ('PASS lifecycle='+$proof.version+' child_node_pinned=true env_restored=true failure_exit_preserved=true')
} finally {
 Pop-Location
 $env:PATH=$savedTaskPath
 $env:npm_node_execpath=$savedTaskNpmNode
 $resolved=[IO.Path]::GetFullPath($taskNpmRoot)
 if(-not $resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'test_cleanup_scope_mismatch'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
