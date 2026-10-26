$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$clientSource = Join-Path $repoDir 'src\main\sharpening-runtime\managed-control-client.cpp'
$fixtureSource = Join-Path $PSScriptRoot 'managed-control-client-fixture.cpp'
$artifactDir = Join-Path $repoDir '.codex\task-artifacts\managed-control-bridge'
$fixture = Join-Path $artifactDir 'managed-control-client-fixture.exe'
$vsRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
& (Join-Path $repoDir 'src\main\sharpening-runtime\build-managed-control-client.ps1')
$compile = 'cl.exe /nologo /O2 /std:c++20 /EHsc /MT /W4 /WX /DWIN32_LEAN_AND_MEAN /Fo"managed-control-client-fixture.obj" /Fe"managed-control-client-fixture.exe" "{0}"' -f $fixtureSource
$cmd = 'call "{0}" >nul && {1} > managed-control-client-fixture-build.log 2>&1' -f $vcvars, $compile
$build = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $cmd) -WorkingDirectory $artifactDir -PassThru -WindowStyle Hidden
$build.WaitForExit()
if ($build.ExitCode -ne 0) { Get-Content -LiteralPath (Join-Path $artifactDir 'managed-control-client-fixture-build.log'); throw 'Fixture compilation failed.' }
$client = Join-Path $artifactDir 'managed-control-client.exe'
$ownedFixtures = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Invoke-Client([byte[]] $InputBytes) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new($client, '--serve')
    $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::new(); $proc.StartInfo = $psi
    [void]$proc.Start()
    $proc.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
    $proc.StandardInput.Close()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { throw "Client returned $($proc.ExitCode): $stderr" }
    return $stdout.TrimEnd("`r", "`n")
}
function Start-Fixture([string] $Mode) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $fixture
    $startInfo.Arguments = '"' + $Mode + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $startInfo
    [void]$proc.Start()
    $ownedFixtures.Add($proc)
    $readyTask = $proc.StandardOutput.ReadLineAsync()
    $errorTask = $proc.StandardError.ReadToEndAsync()
    $limit = [DateTime]::UtcNow.AddSeconds(5)
    while (-not $readyTask.IsCompleted) {
        if ([DateTime]::UtcNow -gt $limit -or $proc.HasExited) { throw "Fixture $Mode did not become ready. $($errorTask.GetAwaiter().GetResult())" }
        Start-Sleep -Milliseconds 20
    }
    $ready = $readyTask.GetAwaiter().GetResult()
    $fields = $ready.Trim().Split(' ')
    if ($fields.Length -ne 2) { throw "Invalid fixture readiness line: [$ready]" }
    return @{ Process = $proc; Pid = $fields[0]; Creation = $fields[1]; ErrorTask = $errorTask }
}
function Wait-FixtureExit($Server, [int] $TimeoutMs, [string] $Name) {
    $exited = $Server.Process.WaitForExit($TimeoutMs)
    $Server.Process.Refresh()
    if (-not $exited -or -not $Server.Process.HasExited) {
        $diagnostic = if ($Server.ErrorTask.IsCompleted) { $Server.ErrorTask.GetAwaiter().GetResult() } else { '(fixture stderr is still open)' }
        throw "$Name fixture did not exit within ${TimeoutMs}ms; pid=$($Server.Process.Id); stderr=[$diagnostic]"
    }
    $exitCode = $Server.Process.ExitCode
    $diagnostic = $Server.ErrorTask.GetAwaiter().GetResult()
    if ($exitCode -ne 0) { throw "$Name fixture exited with $exitCode; stderr=[$diagnostic]" }
}
function Assert-Equal([string] $Actual, [string] $Expected, [string] $Name) {
    $Actual = $Actual.Replace("`r", '').TrimEnd("`n")
    $Expected = $Expected.Replace("`r", '').TrimEnd("`n")
    if ($Actual -cne $Expected) { throw "$Name expected [$($Expected.Replace("`n", '|'))], got [$($Actual.Replace("`n", '|'))]" }
    Write-Output "PASS $Name"
}
function Add-ByteSuffix([string] $Prefix, [byte] $Marker, [string] $Suffix) {
    $prefixBytes = [System.Text.Encoding]::ASCII.GetBytes($Prefix)
    if ($prefixBytes -contains [byte]0) { throw 'Malformed byte prefix unexpectedly contains NUL.' }
    $bytes = [System.Collections.Generic.List[byte]]::new()
    $bytes.AddRange($prefixBytes)
    $bytes.Add($Marker)
    $bytes.AddRange([System.Text.Encoding]::ASCII.GetBytes($Suffix))
    return ,$bytes.ToArray()
}

$malformed = [System.Collections.Generic.List[byte]]::new()
$cases = @(
    [System.Text.Encoding]::ASCII.GetBytes("`n"),
    [System.Text.Encoding]::ASCII.GetBytes("QUERY 22 4294967294 1" + (' ' * 300) + "`n"),
    [System.Text.Encoding]::ASCII.GetBytes("QUERY 23 4294967294 1 extra`n"),
    [System.Text.Encoding]::ASCII.GetBytes("QUERY 18446744073709551616 4294967294 1`n"),
    (Add-ByteSuffix 'QUERY 21 4294967294 1' 0 "junk`n"),
    (Add-ByteSuffix 'QUERY 24 4294967294 1 ' 255 "`n"),
    (Add-ByteSuffix 'QUERY 25 4294967294 1' 26 "junk`n")
)
foreach ($case in $cases) { $malformed.AddRange($case) }
$actual = Invoke-Client $malformed.ToArray()
$expected = "ERROR 0 malformed`nERROR 22 malformed`nERROR 23 malformed`nERROR 0 malformed`nERROR 21 malformed`nERROR 24 malformed`nERROR 25 malformed"
Assert-Equal $actual $expected 'byte-bounded parser negative cases'
$identity = Invoke-Client ([System.Text.Encoding]::ASCII.GetBytes("QUERY 27 4294967294 1`n"))
Assert-Equal $identity 'ERROR 27 pipe_or_identity' 'nonexistent PID identity rejection'

try {
$server = Start-Fixture 'fast'
$query = Invoke-Client ([System.Text.Encoding]::ASCII.GetBytes("QUERY 31 $($server.Pid) $($server.Creation)`n"))
Assert-Equal $query 'RESULT 31 0 7 6' 'owned fixture QUERY'
Wait-FixtureExit $server 5000 'QUERY'

$server = Start-Fixture 'fast'
$set = Invoke-Client ([System.Text.Encoding]::ASCII.GetBytes("SET 32 $($server.Pid) $($server.Creation) 8 1 60`n"))
Assert-Equal $set 'RESULT 32 0 8 6' 'owned fixture SET and acknowledgment'
Wait-FixtureExit $server 5000 'SET'

$server = Start-Fixture 'stall'
$timer = [Diagnostics.Stopwatch]::StartNew()
$timeout = Invoke-Client ([System.Text.Encoding]::ASCII.GetBytes("QUERY 33 $($server.Pid) $($server.Creation)`n"))
$timer.Stop()
Assert-Equal $timeout 'ERROR 33 pipe_or_identity' 'owned fixture stalled reply timeout'
Write-Output "Stall round trip including cancellation drain: $([Math]::Round($timer.Elapsed.TotalSeconds, 2))s"
Wait-FixtureExit $server 7000 'stall'
} finally {
    foreach ($fixtureProcess in $ownedFixtures) {
        $fixtureProcess.Refresh()
        if (-not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue }
    }
}
