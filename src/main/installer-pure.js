// Electron-free installer decisions. Keeping these helpers independent from
// Electron makes the Windows path contract easy to test without launching UI.
import path from 'node:path';

export const PRODUCT_NAME = 'Arc Power';
export const INSTALLER_ARTIFACT_NAME = 'Arc-Power_Installer.exe';
export const PORTABLE_ARTIFACT_NAME = 'Arc-Power_Portable.exe';
export const INSTALLED_EXECUTABLE_NAME = 'Arc Power.exe';
export const START_MENU_RELATIVE = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs');
export const UNINSTALL_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Arc Power';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_KEY_POWERSHELL = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const PROFILE_DIR_NAME = 'ArcPower';
export const CACHE_DIR_NAME = 'ArcPowerCache';
export const CURRENT_BOOT_TASK_NAME = 'ArcPowerBootApply';
export const LEGACY_TASK_NAMES = Object.freeze(['ArcPowerAppOnBoot', 'ArcPowerApplyOnBoot']);
export const CLEANUP_TASK_NAMES = Object.freeze([CURRENT_BOOT_TASK_NAME, ...LEGACY_TASK_NAMES]);
export const CURRENT_RUN_VALUE_NAME = 'ArcPower';
export const LEGACY_RUN_VALUE_NAMES = Object.freeze(['Arc Power']);
export const CLEANUP_RUN_VALUE_NAMES = Object.freeze([CURRENT_RUN_VALUE_NAME, ...LEGACY_RUN_VALUE_NAMES]);
export const UPDATE_PARENT_PID_ARG = '--update-parent-pid';
export const UPDATE_INSTALL_DIR_ARG = '--update-install-dir';

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function requireNonRoot(value, label) {
  const resolved = requireAbsolute(value, label);
  if (resolved === path.parse(resolved).root) throw new TypeError(`${label} must not be a filesystem root`);
  return resolved;
}

function pathsOverlap(left, right) {
  const normalizedLeft = path.resolve(left).toLowerCase();
  const normalizedRight = path.resolve(right).toLowerCase();
  const leftPrefix = normalizedLeft.endsWith(path.sep) ? normalizedLeft : `${normalizedLeft}${path.sep}`;
  const rightPrefix = normalizedRight.endsWith(path.sep) ? normalizedRight : `${normalizedRight}${path.sep}`;
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(rightPrefix)
    || normalizedRight.startsWith(leftPrefix);
}

function isPathWithin(parent, candidate) {
  const normalizedParent = path.resolve(parent).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const prefix = normalizedParent.endsWith(path.sep) ? normalizedParent : `${normalizedParent}${path.sep}`;
  return normalizedParent === normalizedCandidate || normalizedCandidate.startsWith(prefix);
}

/** True only for the portable wrapper carrying the custom installer name. */
export function isInstallerExecutablePath(value) {
  return typeof value === 'string'
    && path.basename(value).toLowerCase() === INSTALLER_ARTIFACT_NAME.toLowerCase();
}

/** The default is deliberately per-user and never under Program Files. */
export function resolveDefaultInstallDir(localAppData) {
  return path.join(requireAbsolute(localAppData, 'localAppData'), 'Programs', PRODUCT_NAME);
}

export function resolveStartMenuShortcutPath(appData) {
  return path.join(requireAbsolute(appData, 'appData'), START_MENU_RELATIVE, `${PRODUCT_NAME}.lnk`);
}

export function resolveDesktopShortcutPath(desktop) {
  return path.join(requireAbsolute(desktop, 'desktop'), `${PRODUCT_NAME}.lnk`);
}

/**
 * Build the complete install/uninstall contract. The profile path is exposed
 * only as documentation/state; cleanup intentionally targets cachePath.
 */
export function createInstallationPlan({
  localAppData,
  appData,
  desktop,
  installDir = resolveDefaultInstallDir(localAppData),
  createDesktopShortcut = true,
  launchAfterInstall = true,
  version = null,
} = {}) {
  const normalizedAppData = requireAbsolute(appData, 'appData');
  const normalizedProfilePath = path.join(normalizedAppData, PROFILE_DIR_NAME);
  const normalizedInstallDir = requireNonRoot(installDir, 'installDir');
  if (pathsOverlap(normalizedInstallDir, normalizedProfilePath)) {
    throw new TypeError('installDir must not equal, contain, or be contained by the durable ArcPower profile path');
  }
  const normalizedDesktop = requireAbsolute(desktop, 'desktop');
  if (typeof createDesktopShortcut !== 'boolean') throw new TypeError('createDesktopShortcut must be boolean');
  if (typeof launchAfterInstall !== 'boolean') throw new TypeError('launchAfterInstall must be boolean');
  if (version !== null && (typeof version !== 'string' || version.length === 0)) throw new TypeError('version must be a non-empty string or null');

  return Object.freeze({
    installDir: normalizedInstallDir,
    executablePath: path.join(normalizedInstallDir, INSTALLED_EXECUTABLE_NAME),
    startMenuShortcutPath: resolveStartMenuShortcutPath(normalizedAppData),
    desktopShortcutPath: resolveDesktopShortcutPath(normalizedDesktop),
    profilePath: normalizedProfilePath,
    cachePath: path.join(normalizedAppData, CACHE_DIR_NAME),
    uninstallRegistryKey: UNINSTALL_REGISTRY_KEY,
    runKey: RUN_KEY,
    runKeyPowerShell: RUN_KEY_POWERSHELL,
    cleanupTaskNames: CLEANUP_TASK_NAMES,
    cleanupRunValueNames: CLEANUP_RUN_VALUE_NAMES,
    cleanupPaths: Object.freeze([
      resolveStartMenuShortcutPath(normalizedAppData),
      resolveDesktopShortcutPath(normalizedDesktop),
      path.join(normalizedAppData, CACHE_DIR_NAME),
      path.join(normalizedInstallDir, INSTALLED_EXECUTABLE_NAME),
      normalizedInstallDir,
    ]),
    createDesktopShortcut,
    launchAfterInstall,
    version,
  });
}

/** True when a process executable is inside the install tree we own. */
export function isOwnedArcPowerProcessPath(processPath, installDir) {
  if (typeof processPath !== 'string' || typeof installDir !== 'string') return false;
  if (!path.isAbsolute(processPath) || !path.isAbsolute(installDir)) return false;
  return isPathWithin(installDir, processPath);
}

/**
 * The detached helper's success predicate. Every owned target must be absent,
 * including the registry/task registrations, and no owned process may remain.
 */
export function isUninstallCleanupComplete({
  pathsAbsent = [],
  runValuesAbsent = [],
  tasksAbsent = [],
  uninstallRegistryAbsent = false,
  remainingOwnedProcesses = 0,
} = {}) {
  return Array.isArray(pathsAbsent)
    && pathsAbsent.length > 0
    && pathsAbsent.every((value) => value === true)
    && Array.isArray(runValuesAbsent)
    && runValuesAbsent.length === CLEANUP_RUN_VALUE_NAMES.length
    && runValuesAbsent.every((value) => value === true)
    && Array.isArray(tasksAbsent)
    && tasksAbsent.length === CLEANUP_TASK_NAMES.length
    && tasksAbsent.every((value) => value === true)
    && uninstallRegistryAbsent === true
    && remainingOwnedProcesses === 0;
}

/** PowerShell single-quoted string literal, useful for generated helper scripts. */
export function powershellLiteral(value) {
  if (typeof value !== 'string') throw new TypeError('PowerShell literal requires a string');
  return `'${value.replaceAll("'", "''")}'`;
}

/** Build the exact command stored in Add/Remove Programs for a temp recovery script. */
export function createUninstallRecoveryCommand({ powershellPath, scriptPath } = {}) {
  for (const [value, label] of [[powershellPath, 'PowerShell path'], [scriptPath, 'recovery script path']]) {
    if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
      throw new TypeError(`${label} must be a non-empty absolute path`);
    }
    if (/[\x00\r\n"]/.test(value)) throw new TypeError(`${label} contains an unsafe command character`);
  }
  const quote = (value) => `"${value}"`;
  return `${quote(powershellPath)} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(scriptPath)} -Retry`;
}

/**
 * The first PowerShell process is only a launcher. It starts the real cleanup
 * helper as a separate hidden process and writes a structured marker after
 * Start-Process has returned a child PID. The installer UI must not close on
 * a bare child `spawn` event because that can race Electron's own shutdown.
 */
export function createUninstallLaunchScript({
  pid,
  cleanupScriptPath,
  markerPath,
  powershellPath,
  workingDirectory,
  attemptNonce,
  statusPath,
  summaryPath,
}) {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer');
  if (typeof cleanupScriptPath !== 'string' || cleanupScriptPath.length === 0) throw new TypeError('cleanup script path is required');
  if (typeof markerPath !== 'string' || markerPath.length === 0) throw new TypeError('launch marker path is required');
  if (typeof powershellPath !== 'string' || powershellPath.length === 0) throw new TypeError('PowerShell path is required');
  if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) throw new TypeError('external working directory is required');
  if (typeof attemptNonce !== 'string' || attemptNonce.length < 16) throw new TypeError('uninstall attempt nonce is required');
  if (typeof statusPath !== 'string' || statusPath.length === 0) throw new TypeError('uninstall status path is required');
  if (typeof summaryPath !== 'string' || summaryPath.length === 0) throw new TypeError('uninstall summary path is required');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$parentPid = ${pid}`,
    `$cleanupScriptPath = ${powershellLiteral(cleanupScriptPath)}`,
    `$markerPath = ${powershellLiteral(markerPath)}`,
    `$powershellPath = ${powershellLiteral(powershellPath)}`,
    `$workingDirectory = ${powershellLiteral(workingDirectory)}`,
    `$attemptNonce = ${powershellLiteral(attemptNonce)}`,
    `$statusPath = ${powershellLiteral(statusPath)}`,
    `$summaryPath = ${powershellLiteral(summaryPath)}`,
    `$diagnosticPath = [string]::Concat($cleanupScriptPath, '.log')`,
    '$arguments = @(',
    "  '-NoLogo',",
    "  '-NoProfile',",
    "  '-NonInteractive',",
    "  '-ExecutionPolicy',",
    "  'Bypass',",
    "  '-File',",
    '  $cleanupScriptPath',
    ')',
    '$helper = Start-Process -FilePath $powershellPath -ArgumentList $arguments -WorkingDirectory $workingDirectory -WindowStyle Hidden -PassThru -ErrorAction Stop',
    'if ($null -eq $helper -or [int]$helper.Id -lt 1) { throw \'cleanup helper did not start\' }',
    '$launchedAt = [DateTime]::UtcNow.ToString(\'o\')',
    '$marker = [pscustomobject]@{ parentPid = $parentPid; helperPid = [int]$helper.Id; attemptNonce = $attemptNonce; launchedAt = $launchedAt } | ConvertTo-Json -Compress',
    '[IO.File]::WriteAllText($markerPath, $marker, [Text.UTF8Encoding]::new($false))',
    '$status = [pscustomobject]@{ parentPid = $parentPid; helperPid = [int]$helper.Id; attemptNonce = $attemptNonce; state = \'launched\'; message = \'Cleanup helper launched; waiting for setup to close\'; updatedAt = $launchedAt; diagnosticPath = $diagnosticPath } | ConvertTo-Json -Compress',
    'foreach ($statusFile in @($statusPath, $summaryPath)) { [IO.File]::WriteAllText($statusFile, $status, [Text.UTF8Encoding]::new($false)) }',
    'try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}',
    'exit 0',
  ].join('\n');
}

/** Parse the launcher handshake without trusting arbitrary marker contents. */
export function parseUninstallLaunchMarker(value, expectedParentPid, expectedNonce, { notBeforeMs = null } = {}) {
  if (typeof value !== 'string' || !Number.isInteger(expectedParentPid) || expectedParentPid < 1) return null;
  if (typeof expectedNonce !== 'string' || expectedNonce.length < 16) return null;
  try {
    const marker = JSON.parse(value);
    if (!marker || typeof marker !== 'object') return null;
    if (marker.parentPid !== expectedParentPid || !Number.isInteger(marker.helperPid) || marker.helperPid < 1) return null;
    if (marker.attemptNonce !== expectedNonce) return null;
    if (typeof marker.launchedAt !== 'string' || Number.isNaN(Date.parse(marker.launchedAt))) return null;
    const launchedAtMs = Date.parse(marker.launchedAt);
    if (notBeforeMs !== null && (!Number.isFinite(notBeforeMs) || launchedAtMs < notBeforeMs)) return null;
    return Object.freeze({ parentPid: marker.parentPid, helperPid: marker.helperPid, attemptNonce: marker.attemptNonce, launchedAt: marker.launchedAt });
  } catch {
    return null;
  }
}

/** Parse a durable cleanup status without accepting a different attempt. */
export function parseUninstallStatus(value, expectedNonce = null) {
  if (typeof value !== 'string') return null;
  try {
    const status = JSON.parse(value);
    if (!status || typeof status !== 'object') return null;
    if (!Number.isInteger(status.parentPid) || status.parentPid < 1) return null;
    if (typeof status.attemptNonce !== 'string' || status.attemptNonce.length < 16) return null;
    if (expectedNonce !== null && status.attemptNonce !== expectedNonce) return null;
    if (!['launched', 'running', 'complete', 'failed'].includes(status.state)) return null;
    if (typeof status.updatedAt !== 'string' || Number.isNaN(Date.parse(status.updatedAt))) return null;
    if (typeof status.message !== 'string' || status.message.length === 0) return null;
    return Object.freeze({
      parentPid: status.parentPid,
      helperPid: Number.isInteger(status.helperPid) && status.helperPid > 0 ? status.helperPid : null,
      attemptNonce: status.attemptNonce,
      state: status.state,
      message: status.message,
      updatedAt: status.updatedAt,
      diagnosticPath: typeof status.diagnosticPath === 'string' ? status.diagnosticPath : null,
    });
  } catch {
    return null;
  }
}

/** Match only this installer's temp artifacts, including artifacts from older PIDs. */
export function isUninstallAttemptArtifactName(name, parentPid = null) {
  if (typeof name !== 'string') return false;
  if (name === 'arc-power-uninstall-last.json') return true;
  const match = /^arc-power-uninstall-(\d+)(?:-[0-9a-f-]{16,})?\.ps1(?:\.(?:launch\.ps1|started\.json|status\.json|log))?$/i.exec(name);
  if (!match) return false;
  if (parentPid === null) return true;
  return Number.isInteger(parentPid) && parentPid > 0 && match[1] === String(parentPid);
}

export function installerModeFromEnvironment({ argv = [], portableExecutableFile = null, parentExecutableFile = null } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.includes('--uninstall')) return 'uninstall';
  if (argv.includes('--update')) return 'update';
  if (argv.includes('--installer')
    || isInstallerExecutablePath(portableExecutableFile)
    || isInstallerExecutablePath(parentExecutableFile)) return 'install';
  return null;
}

export function parseUpdateArguments(argv = []) {
  if (!Array.isArray(argv) || !argv.includes('--update')) return null;
  const pidIndex = argv.indexOf(UPDATE_PARENT_PID_ARG);
  const dirIndex = argv.indexOf(UPDATE_INSTALL_DIR_ARG);
  const parentPid = pidIndex >= 0 ? Number(argv[pidIndex + 1]) : NaN;
  const installDir = dirIndex >= 0 ? argv[dirIndex + 1] : null;
  if (!Number.isInteger(parentPid) || parentPid < 1) throw new TypeError('update parent PID must be a positive integer');
  if (typeof installDir !== 'string' || !path.isAbsolute(installDir)) throw new TypeError('update install directory must be an absolute path');
  return { parentPid, installDir: path.resolve(installDir) };
}

function comparablePath(value) {
  return path.resolve(value).toLowerCase();
}

function registrationExecutable(value, field = '') {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (field === 'DisplayIcon') {
    const iconPath = text.replace(/,\d+$/, '').trim();
    return iconPath || null;
  }
  const match = /^"([^"]+)"/.exec(text) || /^([^\s]+)(?:\s|$)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Validate the identity of an installed update target before the elevated
 * installer waits for the old process or copies any payload. The registration
 * is deliberately supplied by the caller so this contract remains pure and
 * testable without Electron, PowerShell, or a live Windows registry.
 */
export function validateInstalledUpdateTarget({
  installDir,
  registration,
  executableExists = false,
  destinationIsSafe = true,
} = {}) {
  const normalizedInstallDir = requireNonRoot(installDir, 'update installDir');
  if (!registration || typeof registration !== 'object') {
    throw new Error('Arc Power update registration is missing');
  }
  if (String(registration.DisplayName ?? '').trim().toLowerCase() !== PRODUCT_NAME.toLowerCase()) {
    throw new Error('Arc Power update registration identity conflicts with the requested installation');
  }
  if (typeof registration.InstallLocation !== 'string'
    || comparablePath(registration.InstallLocation) !== comparablePath(normalizedInstallDir)) {
    throw new Error('Arc Power update directory conflicts with the registered installation');
  }
  if (destinationIsSafe !== true) {
    throw new Error('Arc Power update destination contains a reparse point or could not be safely inspected');
  }

  const expectedExecutablePath = path.join(normalizedInstallDir, INSTALLED_EXECUTABLE_NAME);
  if (executableExists !== true) {
    throw new Error(`The registered Arc Power executable is missing: ${expectedExecutablePath}`);
  }
  for (const field of ['DisplayIcon', 'UninstallString']) {
    const registeredExecutable = registrationExecutable(registration[field], field);
    if (!registeredExecutable || comparablePath(registeredExecutable) !== comparablePath(expectedExecutablePath)) {
      throw new Error(`Arc Power update registration ${field} does not identify the installed executable`);
    }
  }
  return Object.freeze({ installDir: normalizedInstallDir, executablePath: expectedExecutablePath });
}

/** Classify the structured Get-ScheduledTask probe without inspecting text. */
export function classifyScheduledTaskProbe({ found = false, errorCategory = null } = {}) {
  if (found === true) return 'present';
  if (errorCategory === 'ObjectNotFound') return 'absent';
  return 'error';
}

/** Generate the detached cleanup script used after the installed EXE exits. */
export function createUninstallCleanupScript({
  pid,
  plan,
  scriptPath,
  markerPath = null,
  statusPath = null,
  summaryPath = null,
  attemptNonce = null,
  recoveryCommand,
  recoveryDisplayIcon,
} = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer');
  if (!plan || typeof plan !== 'object') throw new TypeError('plan is required');
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) throw new TypeError('scriptPath is required');
  const cleanupPaths = Array.isArray(plan.cleanupPaths) ? plan.cleanupPaths : [
    plan.startMenuShortcutPath,
    plan.desktopShortcutPath,
    plan.cachePath,
    plan.executablePath,
    plan.installDir,
  ];
  const taskLiterals = plan.cleanupTaskNames.map((value) => powershellLiteral(value)).join(', ');
  const runValueLiterals = plan.cleanupRunValueNames.map((value) => powershellLiteral(value)).join(', ');
  const cleanupPathLiterals = cleanupPaths.map((value) => powershellLiteral(value)).join(', ');
  if (markerPath !== null && (typeof markerPath !== 'string' || markerPath.length === 0)) throw new TypeError('launch marker path must be a non-empty string or null');
  if (statusPath !== null && (typeof statusPath !== 'string' || statusPath.length === 0)) throw new TypeError('status path must be a non-empty string or null');
  if (summaryPath !== null && (typeof summaryPath !== 'string' || summaryPath.length === 0)) throw new TypeError('summary path must be a non-empty string or null');
  if (attemptNonce !== null && (typeof attemptNonce !== 'string' || attemptNonce.length < 16)) throw new TypeError('uninstall attempt nonce must be at least 16 characters or null');
  if ((statusPath === null) !== (summaryPath === null) || (statusPath === null) !== (attemptNonce === null)) throw new TypeError('statusPath, summaryPath, and attemptNonce must be supplied together');
  if (typeof recoveryCommand !== 'string' || recoveryCommand.length === 0) throw new TypeError('recovery command is required');
  if (typeof recoveryDisplayIcon !== 'string' || recoveryDisplayIcon.length === 0) throw new TypeError('recovery display icon is required');
  return [
    'param([switch]$Retry)',
    "$ErrorActionPreference = 'Continue'",
    `$processId = ${pid}`,
    `$installDir = ${powershellLiteral(plan.installDir)}`,
    `$scriptPath = ${powershellLiteral(scriptPath)}`,
    ...(markerPath ? [`$markerPath = ${powershellLiteral(markerPath)}`] : []),
    `$diagnosticPath = ${powershellLiteral(`${scriptPath}.log`)}`,
    ...(statusPath ? [`$statusPath = ${powershellLiteral(statusPath)}`, `$summaryPath = ${powershellLiteral(summaryPath)}`, `$attemptNonce = ${powershellLiteral(attemptNonce)}`] : []),
    `$runKey = ${powershellLiteral(plan.runKeyPowerShell)}`,
    `$uninstallKey = ${powershellLiteral(`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`)}`,
    `$recoveryCommand = ${powershellLiteral(recoveryCommand)}`,
    `$recoveryDisplayIcon = ${powershellLiteral(recoveryDisplayIcon)}`,
    `$taskNames = @(${taskLiterals})`,
    `$runValueNames = @(${runValueLiterals})`,
    `$cleanupPaths = @(${cleanupPathLiterals})`,
    '$processQueryFailed = $false',
    'function Write-Diagnostic([string]$message) { try { Add-Content -LiteralPath $diagnosticPath -Value ("{0:u} {1}" -f [DateTime]::UtcNow, $message) -Encoding UTF8 } catch {} }',
    'try { Set-Location -LiteralPath (Split-Path -Parent $scriptPath) -ErrorAction Stop } catch { Write-Diagnostic ("could not switch recovery helper out of install tree: {0}" -f $_.Exception.Message); exit 1 }',
    ...(statusPath ? [
      'function Write-Status([string]$state, [string]$message) { try { $status = [pscustomobject]@{ parentPid = $processId; attemptNonce = $attemptNonce; state = $state; message = $message; updatedAt = [DateTime]::UtcNow.ToString(\'o\'); diagnosticPath = $diagnosticPath } | ConvertTo-Json -Compress; foreach ($statusFile in @($statusPath, $summaryPath)) { [IO.File]::WriteAllText($statusFile, $status, [Text.UTF8Encoding]::new($false)) } } catch {} }',
      "Write-Status 'running' 'Cleanup helper is waiting for setup to close'",
    ] : []),
    'function Test-OwnedPath([string]$candidate) {',
    '  if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }',
    '  try {',
    '    $root = [IO.Path]::GetFullPath($installDir).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar',
    '    $full = [IO.Path]::GetFullPath($candidate)',
    '    return $full.Equals($root.TrimEnd([IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)',
    '  } catch { return $false }',
    '}',
    'function Get-OwnedProcesses {',
    '  try { return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and (Test-OwnedPath ([string]$_.ExecutablePath)) }) } catch { $script:processQueryFailed = $true; Write-Diagnostic ("could not enumerate Arc Power processes: {0}" -f $_.Exception.Message); return @() }',
    '}',
    'function Stop-OwnedProcesses {',
    '  foreach ($owned in @(Get-OwnedProcesses)) {',
    '    if ([int]$owned.ProcessId -eq $processId) { continue }',
    '    try { Stop-Process -Id ([int]$owned.ProcessId) -Force -ErrorAction Stop } catch { Write-Diagnostic ("could not stop process {0}: {1}" -f $owned.ProcessId, $_.Exception.Message) }',
    '  }',
    '}',
    'function Remove-OwnedPath([string]$target) {',
    '  try { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop } catch { if (Test-Path -LiteralPath $target) { Write-Diagnostic ("could not remove path {0}: {1}" -f $target, $_.Exception.Message) } }',
    '}',
    'function Test-PathAbsent([string]$target) {',
    '  try { return -not (Test-Path -LiteralPath $target -ErrorAction Stop) } catch { Write-Diagnostic ("could not verify path {0}: {1}" -f $target, $_.Exception.Message); return $false }',
    '}',
    'function Test-RunValueAbsent([string]$name) {',
    '  try { $key = Get-Item -LiteralPath $runKey -ErrorAction Stop; return $key.GetValueNames() -notcontains $name } catch {',
    '    if (-not (Test-Path -LiteralPath $runKey -ErrorAction SilentlyContinue)) { return $true }',
    '    Write-Diagnostic ("could not verify Run value {0}: {1}" -f $name, $_.Exception.Message); return $false',
    '  }',
    '}',
    'function Test-TaskAbsent([string]$name) {',
    '  try {',
    '    Get-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null',
    '    return $false',
    '  } catch {',
    '    $category = [string]$_.CategoryInfo.Category',
    '    if ($category -eq "ObjectNotFound") { return $true }',
    '    Write-Diagnostic ("could not verify scheduled task {0}: category {1}; {2}" -f $name, $category, $_.Exception.Message); return $false',
    '  }',
    '}',
    'function Set-RecoveryRegistration {',
    '  try {',
    '    New-Item -Path $uninstallKey -Force -ErrorAction Stop | Out-Null',
    '    New-ItemProperty -Path $uninstallKey -Name \'DisplayName\' -PropertyType String -Value \'Arc Power\' -Force -ErrorAction Stop | Out-Null',
    '    New-ItemProperty -Path $uninstallKey -Name \'UninstallString\' -PropertyType String -Value $recoveryCommand -Force -ErrorAction Stop | Out-Null',
    '    New-ItemProperty -Path $uninstallKey -Name \'QuietUninstallString\' -PropertyType String -Value $recoveryCommand -Force -ErrorAction Stop | Out-Null',
    '    New-ItemProperty -Path $uninstallKey -Name \'DisplayIcon\' -PropertyType String -Value $recoveryDisplayIcon -Force -ErrorAction Stop | Out-Null',
    '    return $true',
    '  } catch { Write-Diagnostic ("could not preserve recovery registration: {0}" -f $_.Exception.Message); return $false }',
    '}',
    'function Test-UninstallRegistryAbsent {',
    '  try { return -not (Test-Path -LiteralPath $uninstallKey -ErrorAction Stop) } catch { Write-Diagnostic ("could not verify uninstall registry key: {0}" -f $_.Exception.Message); return $false }',
    '}',
    'if (-not $Retry) {',
    '  $processDeadline = [DateTime]::UtcNow.AddSeconds(30)',
    '  while ((Get-Process -Id $processId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $processDeadline) { Start-Sleep -Milliseconds 150 }',
    ...(statusPath ? ['  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { Write-Diagnostic "uninstaller process did not exit before the deadline"; Write-Status \'failed\' \'The setup process did not close; retry removal\'; exit 1 }'] : ['  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { Write-Diagnostic "uninstaller process did not exit before the deadline"; exit 1 }']),
    '}',
    '$cleanupDeadline = [DateTime]::UtcNow.AddSeconds(45)',
    'do {',
    '  if (-not (Set-RecoveryRegistration)) { Start-Sleep -Milliseconds 300; continue }',
    '  Stop-OwnedProcesses',
    '  foreach ($taskName in $taskNames) { try { & schtasks.exe /delete /tn $taskName /f *> $null; if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { Write-Diagnostic ("could not remove scheduled task {0}: exit {1}" -f $taskName, $LASTEXITCODE) } } catch { Write-Diagnostic ("could not remove scheduled task {0}: {1}" -f $taskName, $_.Exception.Message) } }',
    '  foreach ($runValueName in $runValueNames) { try { Remove-ItemProperty -LiteralPath $runKey -Name $runValueName -Force -ErrorAction Stop } catch { if (-not (Test-RunValueAbsent $runValueName)) { Write-Diagnostic ("could not remove Run value {0}: {1}" -f $runValueName, $_.Exception.Message) } } }',
    '  foreach ($cleanupPath in $cleanupPaths) { Remove-OwnedPath $cleanupPath }',
    '  $pathsAbsent = @($cleanupPaths | ForEach-Object { Test-PathAbsent $_ })',
    '  $runValuesAbsent = @($runValueNames | ForEach-Object { Test-RunValueAbsent $_ })',
    '  $tasksAbsent = @($taskNames | ForEach-Object { Test-TaskAbsent $_ })',
    '  $remainingOwnedProcesses = @(Get-OwnedProcesses).Count',
    '  if (($pathsAbsent -notcontains $false) -and ($runValuesAbsent -notcontains $false) -and ($tasksAbsent -notcontains $false) -and $remainingOwnedProcesses -eq 0 -and -not $script:processQueryFailed) {',
    '    try { Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction Stop } catch { Write-Diagnostic ("could not remove completed uninstall registration: {0}" -f $_.Exception.Message) }',
    '  }',
    '  $registryAbsent = Test-UninstallRegistryAbsent',
    '  if (($pathsAbsent -notcontains $false) -and ($runValuesAbsent -notcontains $false) -and ($tasksAbsent -notcontains $false) -and $registryAbsent -and $remainingOwnedProcesses -eq 0 -and -not $script:processQueryFailed) {',
    ...(statusPath ? ["    Write-Status 'complete' 'Arc Power cleanup completed'"] : []),
    '    try { Remove-Item -LiteralPath $diagnosticPath -Force -ErrorAction SilentlyContinue } catch {}',
    ...(markerPath ? ['    try { Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue } catch {}'] : []),
    '    try { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction Stop } catch { Write-Diagnostic ("cleanup succeeded but helper self-delete failed: {0}" -f $_.Exception.Message) }',
    '    exit 0',
    '  }',
    '  Write-Diagnostic ("cleanup verification pending: paths={0}; runValues={1}; tasks={2}; registry={3}; processes={4}" -f ($pathsAbsent -join ","), ($runValuesAbsent -join ","), ($tasksAbsent -join ","), $registryAbsent, $remainingOwnedProcesses)',
    '  Start-Sleep -Milliseconds 300',
    '} while ([DateTime]::UtcNow -lt $cleanupDeadline)',
    'Write-Diagnostic "cleanup verification failed; helper retained for diagnosis"',
    ...(statusPath ? ["Write-Status 'failed' 'Cleanup could not remove every Arc Power file or registration; retry removal'"] : []),
    'exit 1',
  ].join('\n');
}
