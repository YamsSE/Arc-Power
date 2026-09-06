// Arc Power custom Windows installer/uninstaller.
//
// The published installer is a portable Electron wrapper with a different
// artifact name. When that wrapper runs, its extracted app directory is the
// current packaged payload, so installation is a normal file copy into the
// user's LocalAppData\Programs directory. The installed executable re-enters
// this module with --uninstall for the matching uninstaller UI.

import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareArcPowerCacheSync } from './cache-lifecycle.js';
import { isElevated } from './elevation.js';
import { applyWindowIconLifecycle, resolveWindowIconPath } from './window-icon.js';
import {
  PRODUCT_NAME,
  INSTALLED_EXECUTABLE_NAME,
  createInstallationPlan,
  createUninstallLaunchScript,
  createUninstallCleanupScript,
  createUninstallRecoveryCommand,
  installerModeFromEnvironment,
  parseUpdateArguments,
  parseUninstallLaunchMarker,
  parseUninstallStatus,
  isUninstallAttemptActive,
  isUninstallAttemptArtifactName,
  powershellLiteral,
  resolveDefaultInstallDir,
  validateInstalledUpdateTarget,
} from './installer-pure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const INSTALLER_HTML = path.join(__dirname, '..', 'installer', 'installer.html');
const INSTALLER_PRELOAD = path.join(__dirname, '..', 'installer', 'installer-preload.cjs');
const INSTALLER_ELEVATION_RELAUNCHED = 'ARC_POWER_INSTALLER_ELEVATION_RELAUNCHED';
const APP_USER_MODEL_ID = 'com.rid.arcpower.desktop';
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_USER_MODEL_ID); } catch { /* best effort */ }
}
const INSTALLER_ICON = resolveWindowIconPath();
const INSTALLER_NATIVE_ICON = (() => {
  try {
    const icon = nativeImage.createFromPath(INSTALLER_ICON);
    if (!icon.isEmpty()) return icon;
  } catch {
    // Fall through to a byte-backed decode for test/dev paths where the
    // native path cannot be resolved through ASAR.
  }
  try {
    return nativeImage.createFromBuffer(readFileSync(INSTALLER_ICON));
  } catch {
    return nativeImage.createEmpty();
  }
})();

function powershellPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function packagedInstallerLaunchTarget() {
  const portableWrapper = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform === 'win32' && typeof portableWrapper === 'string' && path.isAbsolute(portableWrapper) && existsSync(portableWrapper)) {
    return portableWrapper;
  }
  return process.execPath;
}

function packagedInstallerLaunchArguments() {
  const executable = path.resolve(process.execPath).toLowerCase();
  return process.argv.slice(1).filter((argument) => {
    if (!path.isAbsolute(argument)) return true;
    return path.resolve(argument).toLowerCase() !== executable;
  });
}

async function relaunchInstallerElevated() {
  const target = packagedInstallerLaunchTarget();
  const argumentsLiteral = packagedInstallerLaunchArguments().map((argument) => powershellLiteral(argument)).join(', ');
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    `$env:${INSTALLER_ELEVATION_RELAUNCHED} = '1'`,
    `Start-Process -FilePath ${powershellLiteral(target)} -ArgumentList @(${argumentsLiteral}) -Verb RunAs | Out-Null`,
  ].join('\n');
  await runPowerShell(script);
}

async function ensurePackagedInstallerElevation() {
  if (process.platform !== 'win32' || !app.isPackaged || process.env[INSTALLER_ELEVATION_RELAUNCHED] === '1' || isElevated()) return true;
  try {
    await relaunchInstallerElevated();
    app.exit(0);
    return false;
  } catch (error) {
    console.error(`[installer] elevation handoff failed: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

async function runPowerShell(script) {
  await execFileAsync(powershellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedPowerShell(script),
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function createShortcut({ shortcutPath, targetPath, workingDirectory, iconPath = targetPath }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force -Path ${powershellLiteral(path.dirname(shortcutPath))} | Out-Null`,
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${powershellLiteral(shortcutPath)})`,
    `$shortcut.TargetPath = ${powershellLiteral(targetPath)}`,
    `$shortcut.WorkingDirectory = ${powershellLiteral(workingDirectory)}`,
    `$shortcut.Description = ${powershellLiteral(PRODUCT_NAME)}`,
    `$shortcut.IconLocation = ${powershellLiteral(`${iconPath},0`)}`,
    '$shortcut.Save()',
  ].join('\n');
  await runPowerShell(script);
}

async function writeUninstallRegistration(plan, version, { uninstallCommand = null, displayIcon = null } = {}) {
  const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`;
  const command = uninstallCommand || `\"${plan.executablePath}\" --uninstall`;
  const stringValues = {
    DisplayName: PRODUCT_NAME,
    DisplayVersion: version,
    Publisher: 'R.ID',
    InstallLocation: plan.installDir,
    UninstallString: command,
    QuietUninstallString: command,
    DisplayIcon: displayIcon || `${plan.executablePath},0`,
  };
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -Path ${powershellLiteral(key)} -Force | Out-Null`,
    ...Object.entries(stringValues).map(([name, value]) =>
      `New-ItemProperty -Path ${powershellLiteral(key)} -Name ${powershellLiteral(name)} -PropertyType String -Value ${powershellLiteral(value)} -Force | Out-Null`),
    `New-ItemProperty -Path ${powershellLiteral(key)} -Name 'NoModify' -PropertyType DWord -Value 1 -Force | Out-Null`,
    `New-ItemProperty -Path ${powershellLiteral(key)} -Name 'NoRepair' -PropertyType DWord -Value 1 -Force | Out-Null`,
  ];
  await runPowerShell(lines.join('\n'));
}

function windowsPaths() {
  const appData = app.getPath('appData');
  const localAppData = process.env.LOCALAPPDATA || path.join(path.dirname(appData), 'Local');
  return {
    appData,
    localAppData,
    desktop: app.getPath('desktop'),
  };
}

function payloadRoot() {
  const root = path.dirname(process.execPath);
  const executable = path.join(root, INSTALLED_EXECUTABLE_NAME);
  if (!existsSync(executable) || !existsSync(path.join(root, 'resources'))) {
    throw new Error(`The packaged Arc Power payload is unavailable beside ${process.execPath}`);
  }
  return root;
}

function sendProgress(win, percent, message) {
  if (win && !win.isDestroyed()) win.webContents.send('installer:progress', { percent, message });
}

async function readInstalledUpdateRegistration() {
  const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$entry = Get-ItemProperty -LiteralPath ${powershellLiteral(key)} -ErrorAction Stop`,
    '[pscustomobject]@{',
    '  DisplayName = [string]$entry.DisplayName',
    '  InstallLocation = [string]$entry.InstallLocation',
    '  DisplayIcon = [string]$entry.DisplayIcon',
    '  UninstallString = [string]$entry.UninstallString',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  const { stdout } = await execFileAsync(powershellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedPowerShell(script),
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const output = String(stdout ?? '').trim();
  if (!output) throw new Error('Arc Power update registration is missing');
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Arc Power update registration returned invalid structured data');
  }
}

function isSafeUpdateDestination(installDir) {
  let current = path.resolve(installDir);
  while (true) {
    try {
      // Junctions and symbolic links are reported as symbolic links by
      // lstatSync on Windows. Reject every existing component so an attacker
      // cannot redirect the registered destination through a parent reparse
      // point between validation and copy.
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

async function copyPackagedPayload(sourceRoot, installDir) {
  // Electron's ASAR fs wrapper treats any path containing `.asar` as an
  // archive. A recursive copy of the running portable directory therefore
  // tries to inspect the destination `resources\app.asar` while it is still
  // being created and fails with "Invalid package". Temporarily disable that
  // virtual-filesystem behavior so app.asar is copied as an ordinary file.
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    await cp(sourceRoot, installDir, { recursive: true, force: true });
    verifyCopiedPayload(sourceRoot, installDir);
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function verifyCopiedPayload(sourceRoot, installDir) {
  const requiredFiles = [
    INSTALLED_EXECUTABLE_NAME,
    path.join('resources', 'app.asar'),
    path.join('resources', 'app-icon.ico'),
    path.join('resources', 'ArcPowerTaskbar.ico'),
  ];
  for (const relativePath of requiredFiles) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(installDir, relativePath);
    if (!existsSync(sourcePath) || !existsSync(destinationPath)) {
      throw new Error(`Arc Power update verification failed: ${relativePath} is missing after copy`);
    }
    if (sha256File(sourcePath) !== sha256File(destinationPath)) {
      throw new Error(`Arc Power update verification failed: ${relativePath} does not match the downloaded payload`);
    }
  }
}

function launchInstalledApp(executablePath, workingDirectory) {
  // The portable wrapper marks its extracted child process with these
  // variables. If they are inherited by the newly installed app, its startup
  // detector correctly (but incorrectly for this child) thinks it is still
  // the Installer and opens another setup window.
  const environment = { ...process.env };
  delete environment.PORTABLE_EXECUTABLE_FILE;
  delete environment.PORTABLE_EXECUTABLE_DIR;
  delete environment.PORTABLE_EXECUTABLE_APP_FILENAME;
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [], {
      cwd: workingDirectory,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: environment,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function installArcPower(win, options = {}) {
  const paths = windowsPaths();
  const plan = createInstallationPlan({
    ...paths,
    installDir: options.installDir || undefined,
    createDesktopShortcut: options.createDesktopShortcut !== false,
    launchAfterInstall: options.launchAfterInstall !== false,
    version: app.getVersion(),
  });
  const sourceRoot = payloadRoot();
  if (path.resolve(sourceRoot).toLowerCase() === path.resolve(plan.installDir).toLowerCase()) {
    throw new Error('The installer payload and install location cannot be the same directory');
  }

  if (options.updateParentPid !== undefined && options.updateParentPid !== null) {
    await waitForProcessExit(options.updateParentPid);
  }

  sendProgress(win, 8, 'Preparing your Arc Power installation');
  await mkdir(plan.installDir, { recursive: true });
  sendProgress(win, 20, 'Copying the Arc Power application');
  await copyPackagedPayload(sourceRoot, plan.installDir);
  sendProgress(win, 68, 'Creating your Start Menu shortcut');
  await createShortcut({
    shortcutPath: plan.startMenuShortcutPath,
    targetPath: plan.executablePath,
    workingDirectory: plan.installDir,
    iconPath: plan.iconPath,
  });
  if (plan.createDesktopShortcut) {
    sendProgress(win, 78, 'Creating your desktop shortcut');
    await createShortcut({
      shortcutPath: plan.desktopShortcutPath,
      targetPath: plan.executablePath,
      workingDirectory: plan.installDir,
      iconPath: plan.iconPath,
    });
  } else {
    await rm(plan.desktopShortcutPath, { force: true });
  }
  sendProgress(win, 88, 'Registering Arc Power with Windows');
  await writeUninstallRegistration(plan, app.getVersion(), { displayIcon: `${plan.iconPath},0` });
  // The same version gate used by the launched application also runs here.
  // This makes installer completion sufficient to clear an older release's
  // caches, while a same-version reinstall leaves those caches alone.
  prepareArcPowerCacheSync(paths.appData, app.getVersion());
  sendProgress(win, 100, 'Arc Power is ready');
  if (plan.launchAfterInstall) {
    await launchInstalledApp(plan.executablePath, plan.installDir);
  }
  return { ok: true, plan, launched: plan.launchAfterInstall };
}

export function waitForProcessExit(pid, {
  timeoutMs = 60_000,
  pollMs = 250,
  isAlive = (value) => {
    try { process.kill(value, 0); return true; } catch { return false; }
  },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError('parent PID must be a positive integer');
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for process ${pid} to exit`);
      await sleep(pollMs);
    }
  })();
}

async function runInstalledUpdate({ parentPid, installDir }) {
  const diagnosticPath = path.join(app.getPath('temp'), `arc-power-update-${process.pid}.log`);
  try {
    const paths = windowsPaths();
    const registration = await readInstalledUpdateRegistration();
    const validatedTarget = validateInstalledUpdateTarget({
      installDir,
      registration,
      executableExists: existsSync(path.join(path.resolve(installDir), INSTALLED_EXECUTABLE_NAME)),
      destinationIsSafe: isSafeUpdateDestination(installDir),
    });
    const currentPlan = createInstallationPlan({
      ...paths,
      installDir: validatedTarget.installDir,
      createDesktopShortcut: false,
      launchAfterInstall: false,
      version: app.getVersion(),
    });
    const result = await installArcPower(null, {
      installDir: validatedTarget.installDir,
      createDesktopShortcut: existsSync(currentPlan.desktopShortcutPath),
      launchAfterInstall: false,
      updateParentPid: parentPid,
    });
    await launchInstalledApp(result.plan.executablePath, result.plan.installDir);
    app.quit();
    return { ok: true, kind: 'installed', installDir: result.plan.installDir };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    try { await writeFile(diagnosticPath, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ }
    throw new Error(`Installed update failed: ${message}. Diagnostics: ${diagnosticPath}`);
  }
}

async function waitForUninstallLaunchHandshake({ child, markerPath, parentPid, expectedNonce, notBeforeMs, timeoutMs = 8_000, pollMs = 40 }) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (cause = null) => {
      if (settled) return;
      settled = true;
      if (cause) reject(cause); else resolve();
    };
    child.once('error', (cause) => finish(cause));
    child.once('spawn', () => finish());
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let marker = null;
    try {
      marker = parseUninstallLaunchMarker(await readFile(markerPath, 'utf8'), parentPid, expectedNonce, { notBeforeMs });
    } catch { /* launcher is still writing the marker */ }
    if (marker) {
      if (!isProcessAlive(marker.helperPid)) {
        throw new Error('Arc Power uninstall helper exited before its launch handshake was confirmed');
      }
      return marker;
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`Arc Power uninstall launcher exited with code ${child.exitCode} before its helper handshake`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Arc Power uninstall helper did not complete its launch handshake');
}

async function removeStaleUninstallArtifacts(tempDir) {
  let entries = [];
  try { entries = await readdir(tempDir, { withFileTypes: true }); } catch { return; }
  const staleNames = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink())
      && isUninstallAttemptArtifactName(entry.name))
    .map((entry) => entry.name);
  await Promise.all(staleNames.map((name) => rm(path.join(tempDir, name), { force: true }).catch(() => {})));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeUninstallStatusFiles({ statusPath, summaryPath, parentPid, attemptNonce, state, message, diagnosticPath }) {
  const status = JSON.stringify({
    parentPid,
    helperPid: null,
    attemptNonce,
    state,
    message,
    updatedAt: new Date().toISOString(),
    diagnosticPath,
  });
  await Promise.all([
    writeFile(statusPath, status, { encoding: 'utf8', mode: 0o600 }),
    writeFile(summaryPath, status, { encoding: 'utf8', mode: 0o600 }),
  ]);
}

async function readLastUninstallStatus(tempDir) {
  try {
    return parseUninstallStatus(await readFile(path.join(tempDir, 'arc-power-uninstall-last.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function scheduleUninstall(plan) {
  const tempDir = app.getPath('temp');
  const previousStatus = await readLastUninstallStatus(tempDir);
  if (isUninstallAttemptActive(previousStatus, isProcessAlive)) {
    throw new Error('Another Arc Power removal is still in progress; wait for it to finish before retrying.');
  }
  await removeStaleUninstallArtifacts(tempDir);
  const attemptNonce = randomUUID();
  const attemptStartedAt = Date.now();
  const scriptPath = path.join(tempDir, `arc-power-uninstall-${process.pid}-${attemptNonce}.ps1`);
  const launchScriptPath = `${scriptPath}.launch.ps1`;
  const markerPath = `${scriptPath}.started.json`;
  const statusPath = `${scriptPath}.status.json`;
  const summaryPath = path.join(tempDir, 'arc-power-uninstall-last.json');
  const diagnosticPath = `${scriptPath}.log`;
  const powershell = powershellPath();
  const recoveryCommand = createUninstallRecoveryCommand({ powershellPath: powershell, scriptPath });
  await writeFile(scriptPath, createUninstallCleanupScript({
    pid: process.pid,
    plan,
    scriptPath,
    markerPath,
    statusPath,
    summaryPath,
    attemptNonce,
    recoveryCommand,
    recoveryDisplayIcon: `${powershell},0`,
  }), { encoding: 'utf8', mode: 0o600 });
  // Preserve a usable Add/Remove Programs entry before the installed EXE is
  // allowed to exit. The temp script is independent of the install tree and
  // remains registered until the helper proves cleanup succeeded.
  await writeUninstallRegistration(plan, app.getVersion(), {
    uninstallCommand: recoveryCommand,
    displayIcon: `${powershell},0`,
  });
  await writeFile(launchScriptPath, createUninstallLaunchScript({
    pid: process.pid,
    cleanupScriptPath: scriptPath,
    markerPath,
    powershellPath: powershell,
    workingDirectory: tempDir,
    attemptNonce,
    statusPath,
    summaryPath,
  }), { encoding: 'utf8', mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(powershell, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', launchScriptPath,
        ], {
          cwd: tempDir,
          // Keep the short launcher attached until it has written the
          // handshake marker. A detached PowerShell child can exit cleanly
          // on Windows without executing the script when started from an
          // Electron parent, which leaves the UI with a false handshake
          // timeout. The launcher itself starts the real cleanup helper with
          // Start-Process, so only that helper needs to be independent.
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch (cause) {
        reject(cause);
        return;
      }
      void waitForUninstallLaunchHandshake({
        child,
        markerPath,
        parentPid: process.pid,
        expectedNonce: attemptNonce,
        notBeforeMs: attemptStartedAt,
      })
        .then((marker) => {
          if (!child.pid) throw new Error('Could not start the Arc Power uninstall launcher');
          child.unref();
          // The launcher removes itself after writing the marker. Removing a
          // leftover here is safe only after the real helper is independently
          // running, and keeps retries from inheriting stale launch scripts.
          void rm(launchScriptPath, { force: true }).catch(() => {});
          resolve(marker);
        })
        .catch(reject);
    });
  } catch (cause) {
    const statusAfterFailure = await readLastUninstallStatus(tempDir);
    if (!isUninstallAttemptActive(statusAfterFailure, isProcessAlive)) {
      await writeUninstallStatusFiles({
        statusPath,
        summaryPath,
        parentPid: process.pid,
        attemptNonce,
        state: 'failed',
        message: `Could not start the uninstall helper; retry removal${cause instanceof Error ? `: ${cause.message}` : ''}`,
        diagnosticPath,
      }).catch(() => {});
    }
    throw cause;
  }
}

async function uninstallArcPower(win) {
  const paths = windowsPaths();
  const plan = createInstallationPlan({
    ...paths,
    installDir: path.dirname(process.execPath),
    createDesktopShortcut: true,
    launchAfterInstall: false,
    version: app.getVersion(),
  });
  sendProgress(win, 18, 'Preparing to remove Arc Power');
  sendProgress(win, 52, 'Removing shortcuts and Windows registration');
  // Defer all destructive cleanup until this UI process has exited. The
  // running Arc Power process can still have cache files open (for example
  // the DIPS directory), so removing the cache here makes the operation fail
  // before the completion view can be shown.
  const handoff = await scheduleUninstall(plan);
  sendProgress(win, 96, 'Removal is in progress; closing setup');
  return { ok: true, scheduled: true, launchConfirmed: true, helperPid: handoff.helperPid, plan };
}

function registerInstallerIpc(win, mode) {
  let closeRequested = false;
  const handlers = {
    'installer:state': async () => {
      const paths = windowsPaths();
      const installDir = mode === 'uninstall' ? path.dirname(process.execPath) : resolveDefaultInstallDir(paths.localAppData);
      return {
        mode,
        version: app.getVersion(),
        installDir,
        appData: paths.appData,
        profilePath: path.join(paths.appData, 'ArcPower'),
        payloadReady: mode === 'uninstall' || (() => { try { payloadRoot(); return true; } catch { return false; } })(),
        lastUninstallStatus: mode === 'uninstall' ? await readLastUninstallStatus(app.getPath('temp')) : null,
      };
    },
    'installer:choose-directory': async () => {
      const result = await dialog.showOpenDialog(win, { title: 'Choose Arc Power install location', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'installer:install': async (_event, options) => installArcPower(win, options),
    'installer:uninstall': async () => uninstallArcPower(win),
    'installer:close': async () => {
      if (!closeRequested) {
        closeRequested = true;
        // The detached cleanup helper has already acknowledged its own
        // independent launch. Exit the short-lived installer process fully so
        // the helper can observe this PID disappear and remove the install
        // tree without competing with a still-running Electron parent.
        app.exit(0);
      }
      return { ok: true };
    },
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
}

export async function runInstallerMode(mode = 'install') {
  if (!(await ensurePackagedInstallerElevation())) return;
  // Installer/uninstaller UI must not open the legacy `%APPDATA%\arc-power`
  // user-data root. That root is one of the disposable historical caches and
  // would otherwise remain locked while the detached uninstaller tries to
  // remove it after this process exits.
  const installerUserData = path.join(app.getPath('temp'), `ArcPowerInstaller-${process.pid}`);
  mkdirSync(installerUserData, { recursive: true });
  app.setPath('userData', installerUserData);
  await app.whenReady();
  app.setAppUserModelId?.(APP_USER_MODEL_ID);
  if (mode === 'update') {
    try {
      return await runInstalledUpdate(parseUpdateArguments(process.argv));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      try { dialog.showErrorBox('Arc Power update failed', message); } catch { /* best effort */ }
      app.exit(1);
      return { ok: false, error: message };
    }
  }
  const win = new BrowserWindow({
    width: 860,
    height: 570,
    useContentSize: true,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#090b12',
    title: mode === 'uninstall' ? 'Remove Arc Power' : 'Install Arc Power',
    icon: INSTALLER_NATIVE_ICON,
    webPreferences: {
      preload: INSTALLER_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  applyWindowIconLifecycle(win);
  registerInstallerIpc(win, mode);
  // Register the event before loading. Electron can emit ready-to-show before
  // loadFile() resolves; registering it afterwards leaves this intentionally
  // hidden window alive with no visible UI in the portable wrapper.
  const showInstallerWindow = () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    win.focus();
  };
  win.once('ready-to-show', showInstallerWindow);
  win.webContents.once('did-finish-load', showInstallerWindow);
  await win.loadFile(INSTALLER_HTML, { query: { mode } });
  // Keep the custom surface at the native CSS scale. This prevents a stale
  // page zoom from rasterizing the entire installer at a fractional size.
  win.webContents.setZoomFactor(1);
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  // Keep a deterministic fallback for environments where ready-to-show is not
  // emitted (for example, a headless/GPU-fallback portable session).
  showInstallerWindow();
  win.on('closed', () => { if (!app.isQuitting) app.quit(); });
}
