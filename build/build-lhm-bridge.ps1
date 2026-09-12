param(
  [Parameter(Mandatory = $true)]
  [string]$LibreHardwareMonitorDirectory,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\src\main\telemetry\lhm-runtime')
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path $LibreHardwareMonitorDirectory).Path
# Resolve an absolute default path without joining it to the current directory
# a second time. Join-Path treats an absolute child as text on Windows, which
# would otherwise create a malformed `workspace\C:\...` output path.
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$library = Join-Path $source 'LibreHardwareMonitorLib.dll'
$bridgeSource = Join-Path $PSScriptRoot '..\src\main\telemetry\lhm-bridge\ArcPower.LhmBridge.cs'

if (-not (Test-Path -LiteralPath $csc)) { throw "The .NET Framework C# compiler was not found: $csc" }
if (-not (Test-Path -LiteralPath $library)) { throw "LibreHardwareMonitorLib.dll was not found in $source" }

New-Item -ItemType Directory -Path $output -Force | Out-Null
$bridgeOutput = Join-Path $output 'ArcPower.LhmBridge.exe'
& $csc /nologo /target:exe "/out:$bridgeOutput" /platform:x64 /optimize+ `
  /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll `
  /reference:$library $bridgeSource
if ($LASTEXITCODE -ne 0) { throw "The LibreHardwareMonitor bridge compiler exited with $LASTEXITCODE" }

# The bridge is built against the net472 release payload. Copy the managed
# dependencies beside it so the packaged process is self-contained and does
# not bind to a user's unrelated .NET installation or LHM installation.
Get-ChildItem -LiteralPath $source -File -Filter '*.dll' | Copy-Item -Destination $output -Force
Write-Output "Built ArcPower.LhmBridge.exe and copied LHM $source to $output"
