[CmdletBinding()]
param([switch]$UpdateBundled)
$ErrorActionPreference='Stop'
$sourceDir=$PSScriptRoot
$repo=(Resolve-Path -LiteralPath (Join-Path $sourceDir '..\..\..')).Path
$artifacts=Join-Path $repo '.codex\task-artifacts\managed-game-launcher'
$vcvars='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
$source=Join-Path $sourceDir 'managed-game-launcher.cpp'
$output=Join-Path $artifacts 'ArcPower.GameSharpening.exe'
$compile='cl.exe /nologo /O2 /std:c++20 /EHsc /MT /W4 /WX /utf-8 /Fo"launcher.obj" /Fe"{0}" "{1}" bcrypt.lib advapi32.lib user32.lib shell32.lib ole32.lib oleaut32.lib uuid.lib /link /MANIFEST:EMBED /MANIFESTUAC:"level=''asInvoker'' uiAccess=''false''"' -f $output,$source
$command='call "{0}" >nul && {1} > build.log 2>&1' -f $vcvars,$compile
$build=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/s','/c',$command) -WorkingDirectory $artifacts -WindowStyle Hidden -PassThru
$build.WaitForExit()
if($build.ExitCode -ne 0){Get-Content -LiteralPath (Join-Path $artifacts 'build.log');throw "Launcher compilation failed: $($build.ExitCode)"}
if ($UpdateBundled) { Copy-Item -LiteralPath $output -Destination (Join-Path $sourceDir 'ArcPower.GameSharpening.exe') -Force }
Get-FileHash -LiteralPath $output -Algorithm SHA256
