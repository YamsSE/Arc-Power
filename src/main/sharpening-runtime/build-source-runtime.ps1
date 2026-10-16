[CmdletBinding()]
param(
    [string] $SourceDir = (Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path '.codex\task-artifacts\sharpening-render-proof\reshade-source'),
    [string] $PythonDir = 'C:\Users\Yams\.cache\codex-runtimes\codex-primary-runtime\dependencies\python',
    [string] $MSBuildPath = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe',
    [switch] $BuildOnly
)

$ErrorActionPreference = 'Stop'
$artifactDir = $PSScriptRoot
$patchPath = Join-Path $artifactDir 'source-build-local.patch'
$expectedCommit = '18deaa52de0c425a78b329e9cb3c497281cd00ec'
$sourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
$buildToolsDir = Join-Path (Split-Path -Parent $sourceDir) 'rebuild-tools'

if ((git -C $sourceDir rev-parse HEAD).Trim() -ne $expectedCommit) {
    throw 'Source checkout is not pinned ReShade v6.8.0.'
}

# Permit a clean pinned checkout or the exact already-patched tree. Reject any
# partially applied or unrelated tracked changes before building or copying.
git -C $sourceDir apply --reverse --check $patchPath *> $null
$patchAlreadyApplied = ($LASTEXITCODE -eq 0)
if ($patchAlreadyApplied) {
    $actualPatch = ((git -C $sourceDir diff --binary) -join "`n").TrimEnd("`r", "`n")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the tracked source diff.' }
    $expectedPatch = (Get-Content -LiteralPath $patchPath -Raw).TrimEnd("`r", "`n")
    if ($actualPatch -ne $expectedPatch) {
        throw 'Already-patched source contains tracked changes beyond source-build-local.patch.'
    }
}
if ($BuildOnly -and -not $patchAlreadyApplied) {
    throw 'BuildOnly requires the exact source-build-local.patch to be applied.'
}
if (-not $patchAlreadyApplied) {
    if ((git -C $sourceDir status --porcelain --untracked-files=no).Count -ne 0) {
        throw 'Source checkout must be clean before applying source-build-local.patch.'
    }
    git -C $sourceDir apply --check $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Patch does not apply cleanly.' }
    git -C $sourceDir apply $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply source-build-local.patch.' }
}

$builtDll = Join-Path $sourceDir 'bin\x64\Release\ReShade64.dll'
if (-not $BuildOnly) {
    New-Item -ItemType Directory -Force -Path $buildToolsDir | Out-Null
    $siteDir = Join-Path $buildToolsDir 'python-site'
    New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
    $pipCmd = "@echo off`r`n`"$PythonDir\python.exe`" -m pip %* --target `"$siteDir`" --disable-pip-version-check`r`nexit /b %errorlevel%`r`n"
    $pythonCmd = "@echo off`r`nset `"PYTHONPATH=$siteDir;%PYTHONPATH%`"`r`n`"$PythonDir\python.exe`" %*`r`nexit /b %errorlevel%`r`n"
    Set-Content -LiteralPath (Join-Path $buildToolsDir 'pip.cmd') -Value $pipCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $buildToolsDir 'python.cmd') -Value $pythonCmd -Encoding ascii
    $env:PATH = "$buildToolsDir;$PythonDir;$env:PATH"
    & $MSBuildPath (Join-Path $sourceDir 'ReShade.vcxproj') /t:Build '/p:Configuration=Release' '/p:Platform=x64' "/p:SolutionDir=$sourceDir\" '/p:PlatformToolset=v143' '/p:WindowsTargetPlatformVersion=10.0' '/m' '/v:minimal' 2>&1 | Tee-Object -FilePath (Join-Path $artifactDir 'build.log')
    if ($LASTEXITCODE -ne 0) { throw "MSBuild failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $builtDll -PathType Leaf)) {
    throw "Built ReShade runtime was not found at '$builtDll'."
}
$bundledDll = Join-Path $artifactDir 'ArcPower.ReShade64.dll'
Copy-Item -LiteralPath $builtDll -Destination $bundledDll -Force
Get-FileHash -LiteralPath $bundledDll -Algorithm SHA256
