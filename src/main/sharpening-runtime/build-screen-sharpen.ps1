$ErrorActionPreference = 'Stop'

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $sourceDir 'ArcPower.ScreenSharpen.cpp'
$header = Join-Path $sourceDir 'ArcPower.ThumbnailAsr.h'
$captureHeader = Join-Path $sourceDir 'ArcPower.WindowCapture.h'
$cursorHeader = Join-Path $sourceDir 'ArcPower.CursorTransform.h'
$fsrShader = Join-Path $sourceDir 'fsr1\ArcPower.Fsr1.hlsl'
$fsrHeaders = @((Join-Path $sourceDir 'fsr1\ffx_a.h'), (Join-Path $sourceDir 'fsr1\ffx_fsr1.h'))
$output = Join-Path $sourceDir 'ArcPower.ScreenSharpen.exe'
$object = Join-Path $sourceDir 'ArcPower.ScreenSharpen.obj'
$guid = [guid]::NewGuid().ToString('N')
$candidate = Join-Path $sourceDir "ArcPower.ScreenSharpen.$guid.exe"
$candidateObj = Join-Path $sourceDir "ArcPower.ScreenSharpen.$guid.obj"
$candidateLog = Join-Path $sourceDir "ArcPower.ScreenSharpen.$guid.log"
$candidateErr = Join-Path $sourceDir "ArcPower.ScreenSharpen.$guid.err"

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw "Visual Studio locator not found: $vswhere" }
$vsRoot = & $vswhere -latest -products '*' -property installationPath
if (-not $vsRoot) { throw 'No Visual Studio installation with C++ tools was found.' }
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\Include'
$sdk = Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName 'cppwinrt')) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'um\Windows.h')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw "A Windows SDK with cppwinrt was not found under $sdkRoot" }
$cppwinrt = Join-Path $sdk.FullName 'cppwinrt'
$um = Join-Path $sdk.FullName 'um'

foreach ($required in @($source, $header, $captureHeader, $cursorHeader, $fsrShader, $vcvars, $cppwinrt, $um) + $fsrHeaders) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required native build input was not found: $required" }
}

$compile = 'cl.exe /nologo /O2 /std:c++20 /EHsc /MT /DNOMINMAX /DWIN32_LEAN_AND_MEAN /DWINRT_LEAN_AND_MEAN /I "{0}" /I "{1}" /Fo"{2}" /Fe"{3}" "{4}" d3d11.lib dxgi.lib d3dcompiler.lib dcomp.lib windowsapp.lib runtimeobject.lib user32.lib gdi32.lib dwmapi.lib' -f $cppwinrt, $um, $candidateObj, $candidate, $source
$cmd = 'call "{0}" >nul && {1} 1> "{2}" 2> "{3}"' -f $vcvars, $compile, $candidateLog, $candidateErr
try {
    & $env:ComSpec /d /s /c $cmd
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode -or $exitCode -ne 0) { Get-Content -LiteralPath $candidateLog; Get-Content -LiteralPath $candidateErr; throw "ArcPower.ScreenSharpen native compile failed with exit code $exitCode." }
    if (-not (Test-Path -LiteralPath $candidate) -or (Get-Item -LiteralPath $candidate).Length -eq 0) { throw 'Native compiler succeeded without producing a nonempty candidate executable.' }
    if (-not (Test-Path -LiteralPath $candidateObj)) { throw 'Native compiler did not produce the expected fresh object file.' }
    $newExe = Get-Item -LiteralPath $candidate
    $inputs = @($source, $header, $captureHeader, $cursorHeader, $fsrShader) + $fsrHeaders
    if ($inputs | Where-Object { $newExe.LastWriteTimeUtc -lt (Get-Item -LiteralPath $_).LastWriteTimeUtc }) { throw 'Candidate executable is older than one or more source inputs.' }
    Move-Item -LiteralPath $candidate -Destination $output -Force
    $artifact = Get-Item -LiteralPath $output
    Write-Output "Built $($artifact.FullName)"
    Write-Output "Bytes: $($artifact.Length)"
    Write-Output "Source SHA256: $((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash)"
    Write-Output "Header SHA256: $((Get-FileHash -LiteralPath $header -Algorithm SHA256).Hash)"
    Write-Output "Capture header SHA256: $((Get-FileHash -LiteralPath $captureHeader -Algorithm SHA256).Hash)"
    Write-Output "Cursor header SHA256: $((Get-FileHash -LiteralPath $cursorHeader -Algorithm SHA256).Hash)"
    Write-Output "FSR shader SHA256: $((Get-FileHash -LiteralPath $fsrShader -Algorithm SHA256).Hash)"
    Write-Output "EXE SHA256: $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash)"
} finally {
    foreach ($temporary in @($candidate, $candidateObj, $candidateLog, $candidateErr)) { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    if (Test-Path -LiteralPath $object) { Remove-Item -LiteralPath $object -Force }
}
