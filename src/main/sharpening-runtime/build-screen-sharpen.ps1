$ErrorActionPreference = 'Stop'

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $sourceDir 'ArcPower.ScreenSharpen.cpp'
$output = Join-Path $sourceDir 'ArcPower.ScreenSharpen.exe'
$object = Join-Path $sourceDir 'ArcPower.ScreenSharpen.obj'
$vsRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools'
$vcvars = Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat'
$sdkRoot = 'C:/Program Files (x86)/Windows Kits/10/Include'
$cppwinrt = Join-Path $sdkRoot '10.0.26100.0/cppwinrt'
$um = Join-Path $sdkRoot '10.0.26100.0/um'

foreach ($required in @($source, $vcvars, $cppwinrt, $um)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required native build input was not found: $required"
    }
}

$compile = 'cl.exe /nologo /O2 /std:c++20 /EHsc /MT /DNOMINMAX /DWIN32_LEAN_AND_MEAN /DWINRT_LEAN_AND_MEAN /I "{0}" /I "{1}" /Fo"ArcPower.ScreenSharpen.obj" /Fe"ArcPower.ScreenSharpen.exe" "{2}" d3d11.lib dxgi.lib d3dcompiler.lib windowsapp.lib runtimeobject.lib user32.lib dwmapi.lib' -f $cppwinrt, $um, $source
$cmd = 'call "{0}" >nul && {1}' -f $vcvars, $compile
$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $cmd) -WorkingDirectory $sourceDir -Wait -PassThru -NoNewWindow
if ($process.ExitCode -ne 0) {
    throw "ArcPower.ScreenSharpen native compile failed with exit code $($process.ExitCode)."
}
if (-not (Test-Path -LiteralPath $output)) {
    throw "Native compiler exited successfully but did not create: $output"
}
if (Test-Path -LiteralPath $object) {
    Remove-Item -LiteralPath $object -Force
}
$artifact = Get-Item -LiteralPath $output
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
Write-Output "Built $($artifact.FullName)"
Write-Output "Bytes: $($artifact.Length)"
Write-Output "SHA256: $hash"
