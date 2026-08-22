// Fixed Acer packaged bridge helper. electron-builder already unpacks this
// directory, so this file remains executable in app.asar.unpacked. It accepts
// no package names from callers: the package identity and version are pinned.
'use strict';

const { spawn } = require('node:child_process');

const PACKAGE_FULL_NAME = 'ULICTekInc.StereoBox_1.0.172.0_x64__nt9dgb7efx6bt';
const PACKAGE_VERSION = '1.0.172.0';
const SHELL_IDENTITY = 'shell:AppsFolder\\ULICTekInc.StereoBox_nt9dgb7efx6bt!App';
const PACKAGE_AUMID = 'ULICTekInc.StereoBox_nt9dgb7efx6bt!App';

function runPowerShell(script, env = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error('PowerShell helper timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `PowerShell exited ${code}`));
    });
  });
}

async function isInstalled() {
  if (process.platform !== 'win32') return { ok: false, errorCode: 'unsupported-platform' };
  try {
    const raw = await runPowerShell(
      '$ErrorActionPreference = "Stop"; $p = Get-AppxPackage -PackageFullName $env:ARC_ACER_PACKAGE; if ($null -eq $p) { exit 3 }; [pscustomobject]@{ installed = $true; fullName = [string]$p.PackageFullName; version = [string]$p.Version; installLocation = [string]$p.InstallLocation } | ConvertTo-Json -Compress',
      { ARC_ACER_PACKAGE: PACKAGE_FULL_NAME },
    );
    const value = JSON.parse(raw);
    return value?.installed === true && value.fullName === PACKAGE_FULL_NAME && value.version === PACKAGE_VERSION
      && typeof value.installLocation === 'string' && value.installLocation.length > 0
      ? { ok: true, installed: true, fullName: value.fullName, version: value.version, installLocation: value.installLocation }
      : { ok: false, errorCode: 'package-version-mismatch' };
  } catch (error) { return { ok: false, errorCode: 'package-not-found', message: error.message }; }
}

async function snapshotPackageProcesses(packageNameOrTimeout = PACKAGE_FULL_NAME, timeoutMaybe = 10000) {
  if (typeof packageNameOrTimeout === 'string' && packageNameOrTimeout !== PACKAGE_FULL_NAME) {
    return { ok: false, errorCode: 'package-identity-ambiguous', message: 'unexpected Acer package identity' };
  }
  const timeoutMs = typeof packageNameOrTimeout === 'number' ? packageNameOrTimeout : timeoutMaybe;
  const installed = await isInstalled();
  if (installed.ok !== true || typeof installed.installLocation !== 'string' || installed.installLocation.length === 0) return { ok: false, errorCode: installed.errorCode || 'package-not-found' };
  try {
    const raw = await runPowerShell(
      '$ErrorActionPreference = "Stop"; $root = $env:ARC_ACER_ROOT.TrimEnd("\\"); $all = @(Get-CimInstance Win32_Process -ErrorAction Stop); $rootRows = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + "\\", [System.StringComparison]::OrdinalIgnoreCase) }); $packagePids = @($rootRows | ForEach-Object { [int]$_.ProcessId }); $ownedBrokers = @(); foreach ($broker in @($all | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFileName($_.ExecutablePath) -in @("RuntimeBroker.exe", "ApplicationFrameHost.exe")) })) { $cursor = [int]$broker.ProcessId; $seen = @{}; $hits = @(); while ($cursor -gt 0 -and -not $seen.ContainsKey($cursor)) { $seen[$cursor] = $true; if ($packagePids -contains $cursor) { $hits += $cursor }; $node = $all | Where-Object { [int]$_.ProcessId -eq $cursor } | Select-Object -First 1; if ($null -eq $node) { break }; $cursor = [int]$node.ParentProcessId }; if ($hits.Count -gt 1) { throw "Acer package broker ownership is ambiguous" }; if ($hits.Count -eq 1) { $ownedBrokers += $broker } }; $rows = @($rootRows | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationDate = [string]$_.CreationDate; executablePath = [string]$_.ExecutablePath; packageFullName = $env:ARC_ACER_PACKAGE; processKind = "package"; provenance = "package-root" } }) + @($ownedBrokers | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationDate = [string]$_.CreationDate; executablePath = [string]$_.ExecutablePath; packageFullName = $env:ARC_ACER_PACKAGE; processKind = "owned-broker"; provenance = "package-descendant" } }); $rows | ConvertTo-Json -Compress',
      { ARC_ACER_ROOT: installed.installLocation, ARC_ACER_PACKAGE: PACKAGE_FULL_NAME },
      Math.max(1, Math.min(10000, timeoutMs)),
    );
    if (!raw.trim()) return { ok: true, processes: [] };
    const value = JSON.parse(raw);
    const rows = Array.isArray(value) ? value : [value];
    if (rows.some((row) => !Number.isInteger(row?.pid) || row.pid <= 0
      || !Number.isInteger(row?.parentPid) || row.parentPid < 0
      || typeof row.creationDate !== 'string' || row.creationDate.length === 0
      || typeof row.executablePath !== 'string' || row.executablePath.length === 0
      || row.packageFullName !== PACKAGE_FULL_NAME
      || !['package', 'owned-broker'].includes(row.processKind)
      || (row.processKind === 'package' && row.provenance !== 'package-root')
      || (row.processKind === 'owned-broker' && row.provenance !== 'package-descendant'))) {
      return { ok: false, errorCode: 'package-identity-ambiguous', message: 'Acer package process identity is incomplete or provenance is invalid' };
    }
    return { ok: true, processes: rows };
  } catch (error) { return { ok: false, errorCode: 'package-identity-ambiguous', message: error.message }; }
}

async function activate(identity = SHELL_IDENTITY) {
  if (identity !== SHELL_IDENTITY || process.platform !== 'win32') return { ok: false, errorCode: 'unsupported' };
  try {
    const activationStartedAt = Date.now();
    const raw = await runPowerShell(`$ErrorActionPreference = "Stop"
$source = @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  [PreserveSig]
  int ActivateApplication(
    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments,
    uint options,
    out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C"), ClassInterface(ClassInterfaceType.None)]
public class ApplicationActivationManager { }
"@
Add-Type -TypeDefinition $source
$manager = New-Object -TypeName ApplicationActivationManager
[uint32]$processId = 0
$hr = $manager.ActivateApplication($env:ARC_ACER_AUMID, $null, 0, [ref]$processId)
if ($hr -ne 0) { throw ("IApplicationActivationManager.ActivateApplication failed: 0x{0:X8}" -f ([uint32]$hr)) }
[pscustomobject]@{ pid = [int]$processId } | ConvertTo-Json -Compress
`, { ARC_ACER_AUMID: PACKAGE_AUMID }, 10000);
    const launch = JSON.parse(raw);
    const activationPid = Number(launch?.pid);
    if (!Number.isInteger(activationPid) || activationPid <= 0) {
      return { ok: false, errorCode: 'activation-failed', message: 'Acer activation did not return a process identity' };
    }
    const deadline = activationStartedAt + 10000;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const snapshot = await snapshotPackageProcesses(Math.min(1000, remaining));
      if (snapshot?.ok === true && snapshot.processes?.some((item) => item.pid === activationPid && item.processKind === 'package')) {
        return { ok: true, processes: snapshot.processes, activationStartedAt, activationPid };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    return { ok: false, errorCode: 'activation-failed', message: 'Acer activation did not produce its returned package process identity before the launch deadline' };
  } catch (error) { return { ok: false, errorCode: 'activation-failed', message: error.message }; }
}
async function hideWindow(pids, proof = {}) {
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) return { ok: false, errorCode: 'unknown-process' };
  if (process.platform !== 'win32') return { ok: false, errorCode: 'unsupported-platform' };
  try {
    const raw = await runPowerShell(
      '$ErrorActionPreference = "Stop"; Add-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ArcPowerWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); }\n"@; $root = $env:ARC_ACER_ROOT.TrimEnd("\\"); $proof = @(ConvertFrom-Json $env:ARC_ACER_PROOF); $ok = $true; $windowCount = 0; $bad = @(); $ids = ConvertFrom-Json $env:ARC_ACER_PIDS; foreach ($id in $ids) { try { $p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$id); $expected = $proof | Where-Object { [int]$_.pid -eq [int]$id } | Select-Object -First 1; $underRoot = $null -ne $p -and $p.ExecutablePath -and $p.ExecutablePath.StartsWith($root + "\\", [System.StringComparison]::OrdinalIgnoreCase); $brokerName = if ($p -and $p.ExecutablePath) { [System.IO.Path]::GetFileName($p.ExecutablePath) } else { "" }; $allowed = $expected -and (([string]$expected.processKind -eq "package" -and $underRoot) -or ([string]$expected.processKind -eq "owned-broker" -and [string]$expected.provenance -eq "package-descendant" -and $brokerName -in @("RuntimeBroker.exe", "ApplicationFrameHost.exe"))); if ($null -eq $p -or $null -eq $expected -or [string]$expected.packageFullName -ne $env:ARC_ACER_PACKAGE -or -not $allowed -or [string]$expected.executablePath -ne [string]$p.ExecutablePath -or [int]$expected.parentPid -ne [int]$p.ParentProcessId -or [string]$expected.creationDate -ne [string]$p.CreationDate) { $bad += [int]$id; continue }; $hwnd = Get-Process -Id ([int]$id) -ErrorAction Stop | ForEach-Object { $_.MainWindowHandle }; if ($hwnd -ne [IntPtr]::Zero) { $windowCount++; [ArcPowerWindow]::ShowWindowAsync($hwnd, 0) | Out-Null } } catch { $bad += [int]$id } }; [pscustomobject]@{ ok = ($bad.Count -eq 0); noWindow = ($windowCount -eq 0); bad = $bad } | ConvertTo-Json -Compress',
      { ARC_ACER_ROOT: proof.packageRoot ?? '', ARC_ACER_PIDS: JSON.stringify(pids), ARC_ACER_PROOF: JSON.stringify(proof.identities ?? []), ARC_ACER_PACKAGE: PACKAGE_FULL_NAME },
    );
    const value = JSON.parse(raw);
    return value?.ok === true ? { ok: true, noWindow: value.noWindow === true, pids: [...pids] } : { ok: false, errorCode: 'window-failed', bad: value?.bad ?? pids };
  } catch (error) { return { ok: false, errorCode: 'window-failed', message: error.message }; }
}

async function terminatePids(pids, proof = {}) {
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) return { ok: false, errorCode: 'unknown-process' };
  if (process.platform !== 'win32') return { ok: false, errorCode: 'unsupported-platform' };
  const installed = await isInstalled();
  if (installed.ok !== true) return installed;
  try {
    const raw = await runPowerShell(
      '$ErrorActionPreference = "Stop"; $root = $env:ARC_ACER_ROOT.TrimEnd("\\"); $proof = @(ConvertFrom-Json $env:ARC_ACER_PROOF); $ids = @(ConvertFrom-Json $env:ARC_ACER_PIDS); $bad = @(); foreach ($id in $ids) { try { $p = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$id); $expected = $proof | Where-Object { [int]$_.pid -eq [int]$id } | Select-Object -First 1; $underRoot = $null -ne $p -and $p.ExecutablePath -and $p.ExecutablePath.StartsWith($root + "\\", [System.StringComparison]::OrdinalIgnoreCase); $brokerName = if ($p -and $p.ExecutablePath) { [System.IO.Path]::GetFileName($p.ExecutablePath) } else { "" }; $allowed = $expected -and (([string]$expected.processKind -eq "package" -and $underRoot) -or ([string]$expected.processKind -eq "owned-broker" -and [string]$expected.provenance -eq "package-descendant" -and $brokerName -in @("RuntimeBroker.exe", "ApplicationFrameHost.exe"))); if ($null -eq $p -or $null -eq $expected -or [string]$expected.packageFullName -ne $env:ARC_ACER_PACKAGE -or -not $allowed -or [string]$expected.executablePath -ne [string]$p.ExecutablePath -or [int]$expected.parentPid -ne [int]$p.ParentProcessId -or [string]$expected.creationDate -ne [string]$p.CreationDate) { $bad += [int]$id } else { Stop-Process -Id ([int]$id) -Force -ErrorAction Stop } } catch { $bad += [int]$id } }; [pscustomobject]@{ ok = ($bad.Count -eq 0); bad = $bad } | ConvertTo-Json -Compress',
      { ARC_ACER_ROOT: installed.installLocation, ARC_ACER_PIDS: JSON.stringify([...new Set(pids)]), ARC_ACER_PROOF: JSON.stringify(proof?.identities ?? []), ARC_ACER_PACKAGE: PACKAGE_FULL_NAME },
      10000,
    );
    const value = JSON.parse(raw);
    return value?.ok === true ? { ok: true, pids: [...new Set(pids)] } : { ok: false, errorCode: 'termination-failed', pids: value?.bad ?? pids };
  } catch (error) { return { ok: false, errorCode: 'termination-failed', message: error.message }; }
}

module.exports = {
  PACKAGE_FULL_NAME,
  PACKAGE_VERSION,
  SHELL_IDENTITY,
  isInstalled,
  snapshotPackageProcesses,
  activate,
  hideWindow,
  terminatePids,
};
