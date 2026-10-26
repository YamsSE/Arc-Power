$ErrorActionPreference = 'Stop'
$testDir = $PSScriptRoot
$repoDir = (Resolve-Path -LiteralPath (Join-Path $testDir '..')).Path
$artifactDir = Join-Path $repoDir '.codex\task-artifacts\asr-runtime-v2'
$source = Join-Path $testDir 'native-screen-runtime-v2-probe.cpp'
$output = Join-Path $artifactDir 'native-screen-runtime-v2-probe.exe'
$vsRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0'
$cppwinrt = Join-Path $sdkRoot 'cppwinrt'
$um = Join-Path $sdkRoot 'um'
foreach ($required in @($source, $vcvars, $cppwinrt, $um)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required native build input was not found: $required" }
}
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$compile = 'cl.exe /nologo /O2 /std:c++20 /EHsc /MT /DNOMINMAX /DWIN32_LEAN_AND_MEAN /DWINRT_LEAN_AND_MEAN /I "{0}" /I "{1}" /I "{2}" /Fo"native-screen-runtime-v2-probe.obj" /Fe"native-screen-runtime-v2-probe.exe" "{3}" d3d11.lib dxgi.lib d3dcompiler.lib windowsapp.lib runtimeobject.lib user32.lib gdi32.lib dwmapi.lib' -f $cppwinrt, $um, $repoDir, $source
$cmd = 'call "{0}" >nul && {1}' -f $vcvars, $compile
$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $cmd) -WorkingDirectory $artifactDir -Wait -PassThru -NoNewWindow
if ($process.ExitCode -ne 0) { throw "Native screen runtime v2 probe compile failed with exit code $($process.ExitCode)." }
if (-not (Test-Path -LiteralPath $output)) { throw "Native compiler exited successfully but did not create: $output" }
Get-FileHash -LiteralPath $output -Algorithm SHA256
