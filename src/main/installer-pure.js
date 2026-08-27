// Electron-free installer decisions. Keeping these helpers independent from
// Electron makes the Windows path contract easy to test without launching UI.
import path from 'node:path';

export const PRODUCT_NAME = 'Arc Power';
export const INSTALLER_ARTIFACT_NAME = 'Arc-Power_Installer.exe';
export const PORTABLE_ARTIFACT_NAME = 'Arc-Power_Portable.exe';
export const INSTALLED_EXECUTABLE_NAME = 'Arc Power.exe';
export const START_MENU_RELATIVE = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs');
export const UNINSTALL_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Arc Power';
export const PROFILE_DIR_NAME = 'ArcPower';
export const CACHE_DIR_NAME = 'ArcPowerCache';

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
  const normalizedInstallDir = requireNonRoot(installDir, 'installDir');
  const normalizedAppData = requireAbsolute(appData, 'appData');
  const normalizedDesktop = requireAbsolute(desktop, 'desktop');
  if (typeof createDesktopShortcut !== 'boolean') throw new TypeError('createDesktopShortcut must be boolean');
  if (typeof launchAfterInstall !== 'boolean') throw new TypeError('launchAfterInstall must be boolean');
  if (version !== null && (typeof version !== 'string' || version.length === 0)) throw new TypeError('version must be a non-empty string or null');

  return Object.freeze({
    installDir: normalizedInstallDir,
    executablePath: path.join(normalizedInstallDir, INSTALLED_EXECUTABLE_NAME),
    startMenuShortcutPath: resolveStartMenuShortcutPath(normalizedAppData),
    desktopShortcutPath: resolveDesktopShortcutPath(normalizedDesktop),
    profilePath: path.join(normalizedAppData, PROFILE_DIR_NAME),
    cachePath: path.join(normalizedAppData, CACHE_DIR_NAME),
    uninstallRegistryKey: UNINSTALL_REGISTRY_KEY,
    createDesktopShortcut,
    launchAfterInstall,
    version,
  });
}

/** PowerShell single-quoted string literal, useful for generated helper scripts. */
export function powershellLiteral(value) {
  if (typeof value !== 'string') throw new TypeError('PowerShell literal requires a string');
  return `'${value.replaceAll("'", "''")}'`;
}

export function installerModeFromEnvironment({ argv = [], portableExecutableFile = null, parentExecutableFile = null } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.includes('--uninstall')) return 'uninstall';
  if (argv.includes('--installer')
    || isInstallerExecutablePath(portableExecutableFile)
    || isInstallerExecutablePath(parentExecutableFile)) return 'install';
  return null;
}

/** Generate the detached cleanup script used after the installed EXE exits. */
export function createUninstallCleanupScript({ pid, plan, scriptPath } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer');
  if (!plan || typeof plan !== 'object') throw new TypeError('plan is required');
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) throw new TypeError('scriptPath is required');
  const shortcutPaths = [plan.startMenuShortcutPath, plan.desktopShortcutPath]
    .map((value) => `Remove-Item -LiteralPath ${powershellLiteral(value)} -Force -ErrorAction SilentlyContinue`);
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$processId = ${pid}`,
    '$deadline = [DateTime]::UtcNow.AddSeconds(20)',
    'while ((Get-Process -Id $processId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 150 }',
    ...shortcutPaths,
    `Remove-Item -LiteralPath ${powershellLiteral(plan.cachePath)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath ${powershellLiteral(`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath ${powershellLiteral(plan.installDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath ${powershellLiteral(scriptPath)} -Force -ErrorAction SilentlyContinue`,
  ].join('\n');
}
