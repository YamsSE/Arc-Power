$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path -LiteralPath (Join-Path $sourceDir '..\..\..')).Path
$artifactDir = Join-Path $repoDir '.codex\task-artifacts\managed-control-bridge'
$source = Join-Path $sourceDir 'managed-control-client.cpp'
$output = Join-Path $artifactDir 'managed-control-client.exe'
$vsRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
foreach ($required in @($source, $vcvars)) { if (-not (Test-Path -LiteralPath $required)) { throw "Required native build input was not found: $required" } }
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$compile = 'cl.exe /nologo /O2 /std:c++20 /EHsc /MT /W4 /WX /DWIN32_LEAN_AND_MEAN /Fo"managed-control-client.obj" /Fe"managed-control-client.exe" "{0}" advapi32.lib' -f $source
$cmd = 'call "{0}" >nul && {1} > managed-control-client-build.log 2>&1' -f $vcvars, $compile
$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $cmd) -WorkingDirectory $artifactDir -PassThru -WindowStyle Hidden
$process.WaitForExit()
if ($process.ExitCode -ne 0) { Get-Content -LiteralPath (Join-Path $artifactDir 'managed-control-client-build.log'); throw "Managed control client compile failed with exit code $($process.ExitCode)." }
if (-not (Test-Path -LiteralPath $output)) { throw "Native compiler did not create: $output" }
$artifact = Get-Item -LiteralPath $output
Write-Output "Built $($artifact.FullName)"
Write-Output "Bytes: $($artifact.Length)"
Write-Output "SHA256: $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash)"
