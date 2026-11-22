$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $PSScriptRoot 'native\d3d12-uploadheap-query.cpp'
$outputDir = Join-Path $repoDir 'src\main\native'
$output = Join-Path $outputDir 'ArcPower.D3D12UploadHeapQuery.exe'
$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$vsRoot = $env:VSINSTALLDIR
$vswhere = if ($programFilesX86) { Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe' } else { $null }
if (-not $vsRoot -and $vswhere -and (Test-Path -LiteralPath $vswhere)) {
    $vsRoot = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
}
if (-not $vsRoot) { throw 'Visual Studio C++ Build Tools were not found through VSINSTALLDIR or vswhere.' }
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
$sdkDir = $env:WindowsSdkDir
$sdkBase = if ($sdkDir) { $sdkDir.TrimEnd('\\') } elseif ($programFilesX86) { Join-Path $programFilesX86 'Windows Kits\10' } else { $null }
$sdkIncludeRoot = if ($sdkBase) { Join-Path $sdkBase 'Include' } else { $null }
if (-not $sdkIncludeRoot -or -not (Test-Path -LiteralPath $sdkIncludeRoot)) { throw 'Windows 10/11 SDK include files were not found.' }
$sdkVersion = Get-ChildItem -LiteralPath $sdkIncludeRoot -Directory | ForEach-Object {
    $parsed = $null
    if ([version]::TryParse($_.Name, [ref]$parsed)) {
        $header = Join-Path $_.FullName 'um\d3d12.h'
        if ((Test-Path -LiteralPath $header) -and (Select-String -LiteralPath $header -Pattern 'D3D12_FEATURE_D3D12_OPTIONS16' -Quiet)) {
            [pscustomobject]@{ Name = $_.Name; Version = $parsed }
        }
    }
} | Sort-Object Version -Descending | Select-Object -First 1
if (-not $sdkVersion) { throw 'No installed Windows SDK has the D3D12 OPTIONS16 declarations required by this helper.' }
$sdkRoot = Join-Path $sdkIncludeRoot $sdkVersion.Name
$sdkLibRoot = Join-Path (Join-Path $sdkBase 'Lib') $sdkVersion.Name
$um = Join-Path $sdkRoot 'um'
$shared = Join-Path $sdkRoot 'shared'
$libUmX64 = Join-Path $sdkLibRoot 'um\x64'
foreach ($required in @($source, $vcvars, $um, $shared, $libUmX64)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required native build input was not found: $required" }
}
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$workingDir = Join-Path $repoDir '.codex\task-artifacts\d3d12-uploadheap-build'
New-Item -ItemType Directory -Force -Path $workingDir | Out-Null
$compile = 'cl.exe /nologo /O2 /std:c++17 /EHsc /MT /W4 /WX /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /I "{0}" /I "{1}" /LIBPATH:"{2}" /Fo"d3d12-uploadheap-query.obj" /Fe"{3}" "{4}" d3d12.lib dxgi.lib gdi32.lib' -f $um, $shared, $libUmX64, $output, $source
$log = Join-Path $workingDir 'build.log'
$cmd = 'call "{0}" >nul && {1} > "{2}" 2>&1' -f $vcvars, $compile, $log
$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $cmd) -WorkingDirectory $workingDir -PassThru -WindowStyle Hidden
$process.WaitForExit()
if ($process.ExitCode -ne 0) {
    Get-Content -LiteralPath $log
    throw "D3D12 upload heap query helper compilation failed with exit code $($process.ExitCode)."
}
if (-not (Test-Path -LiteralPath $output)) { throw "Native compiler did not create: $output" }
$artifact = Get-Item -LiteralPath $output
Write-Output "Built $($artifact.FullName)"
Write-Output "Windows SDK: $($sdkVersion.Name)"
Write-Output "Bytes: $($artifact.Length)"
Write-Output "SHA256: $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash)"
