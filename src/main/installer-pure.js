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
export function createUninstallCleanupScript({ pid, plan, scriptPath } = {}) {
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
  return [
    "$ErrorActionPreference = 'Continue'",
    `$processId = ${pid}`,
    `$installDir = ${powershellLiteral(plan.installDir)}`,
    `$scriptPath = ${powershellLiteral(scriptPath)}`,
    `$diagnosticPath = ${powershellLiteral(`${scriptPath}.log`)}`,
    `$runKey = ${powershellLiteral(plan.runKeyPowerShell)}`,
    `$taskNames = @(${taskLiterals})`,
    `$runValueNames = @(${runValueLiterals})`,
    `$cleanupPaths = @(${cleanupPathLiterals})`,
    '$processQueryFailed = $false',
    'function Write-Diagnostic([string]$message) { try { Add-Content -LiteralPath $diagnosticPath -Value ("{0:u} {1}" -f [DateTime]::UtcNow, $message) -Encoding UTF8 } catch {} }',
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
    'function Test-UninstallRegistryAbsent {',
    `  try { return -not (Test-Path -LiteralPath ${powershellLiteral(`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`)} -ErrorAction Stop) } catch { Write-Diagnostic ("could not verify uninstall registry key: {0}" -f $_.Exception.Message); return $false }`,
    '}',
    '$processDeadline = [DateTime]::UtcNow.AddSeconds(30)',
    'while ((Get-Process -Id $processId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $processDeadline) { Start-Sleep -Milliseconds 150 }',
    'if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { Write-Diagnostic "uninstaller process did not exit before the deadline"; exit 1 }',
    '$cleanupDeadline = [DateTime]::UtcNow.AddSeconds(45)',
    'do {',
    '  Stop-OwnedProcesses',
    '  foreach ($taskName in $taskNames) { try { & schtasks.exe /delete /tn $taskName /f *> $null; if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { Write-Diagnostic ("could not remove scheduled task {0}: exit {1}" -f $taskName, $LASTEXITCODE) } } catch { Write-Diagnostic ("could not remove scheduled task {0}: {1}" -f $taskName, $_.Exception.Message) } }',
    '  foreach ($runValueName in $runValueNames) { try { Remove-ItemProperty -LiteralPath $runKey -Name $runValueName -Force -ErrorAction Stop } catch { if (-not (Test-RunValueAbsent $runValueName)) { Write-Diagnostic ("could not remove Run value {0}: {1}" -f $runValueName, $_.Exception.Message) } } }',
    `  Remove-Item -LiteralPath ${powershellLiteral(`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`)} -Recurse -Force -ErrorAction SilentlyContinue`,
    '  foreach ($cleanupPath in $cleanupPaths) { Remove-OwnedPath $cleanupPath }',
    '  $pathsAbsent = @($cleanupPaths | ForEach-Object { Test-PathAbsent $_ })',
    '  $runValuesAbsent = @($runValueNames | ForEach-Object { Test-RunValueAbsent $_ })',
    '  $tasksAbsent = @($taskNames | ForEach-Object { Test-TaskAbsent $_ })',
    '  $registryAbsent = Test-UninstallRegistryAbsent',
    '  $remainingOwnedProcesses = @(Get-OwnedProcesses).Count',
    '  if (($pathsAbsent -notcontains $false) -and ($runValuesAbsent -notcontains $false) -and ($tasksAbsent -notcontains $false) -and $registryAbsent -and $remainingOwnedProcesses -eq 0 -and -not $script:processQueryFailed) {',
    '    try { Remove-Item -LiteralPath $diagnosticPath -Force -ErrorAction SilentlyContinue } catch {}',
    '    try { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction Stop } catch { Write-Diagnostic ("cleanup succeeded but helper self-delete failed: {0}" -f $_.Exception.Message) }',
    '    exit 0',
    '  }',
    '  Write-Diagnostic ("cleanup verification pending: paths={0}; runValues={1}; tasks={2}; registry={3}; processes={4}" -f ($pathsAbsent -join ","), ($runValuesAbsent -join ","), ($tasksAbsent -join ","), $registryAbsent, $remainingOwnedProcesses)',
    '  Start-Sleep -Milliseconds 300',
    '} while ([DateTime]::UtcNow -lt $cleanupDeadline)',
    'Write-Diagnostic "cleanup verification failed; helper retained for diagnosis"',
    'exit 1',
  ].join('\n');
}
