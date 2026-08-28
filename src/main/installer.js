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
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { removeUserDataTree } from './cache-lifecycle.js';
import {
  PRODUCT_NAME,
  INSTALLED_EXECUTABLE_NAME,
  createInstallationPlan,
  createUninstallCleanupScript,
  installerModeFromEnvironment,
  parseUpdateArguments,
  powershellLiteral,
  resolveDefaultInstallDir,
  validateInstalledUpdateTarget,
} from './installer-pure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const INSTALLER_HTML = path.join(__dirname, '..', 'installer', 'installer.html');
const INSTALLER_PRELOAD = path.join(__dirname, '..', 'installer', 'installer-preload.cjs');
const INSTALLER_ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const INSTALLER_NATIVE_ICON = (() => {
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

async function runPowerShell(script) {
  await execFileAsync(powershellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedPowerShell(script),
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function createShortcut({ shortcutPath, targetPath, workingDirectory }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force -Path ${powershellLiteral(path.dirname(shortcutPath))} | Out-Null`,
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${powershellLiteral(shortcutPath)})`,
    `$shortcut.TargetPath = ${powershellLiteral(targetPath)}`,
    `$shortcut.WorkingDirectory = ${powershellLiteral(workingDirectory)}`,
    `$shortcut.Description = ${powershellLiteral(PRODUCT_NAME)}`,
    `$shortcut.IconLocation = ${powershellLiteral(`${targetPath},0`)}`,
    '$shortcut.Save()',
  ].join('\n');
  await runPowerShell(script);
}

async function writeUninstallRegistration(plan, version) {
  const key = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}`;
  const uninstallCommand = `\"${plan.executablePath}\" --uninstall`;
  const stringValues = {
    DisplayName: PRODUCT_NAME,
    DisplayVersion: version,
    Publisher: 'R.ID',
    InstallLocation: plan.installDir,
    UninstallString: uninstallCommand,
    QuietUninstallString: uninstallCommand,
    DisplayIcon: `${plan.executablePath},0`,
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
  } finally {
    process.noAsar = previousNoAsar;
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
  });
  if (plan.createDesktopShortcut) {
    sendProgress(win, 78, 'Creating your desktop shortcut');
    await createShortcut({
      shortcutPath: plan.desktopShortcutPath,
      targetPath: plan.executablePath,
      workingDirectory: plan.installDir,
    });
  } else {
    await rm(plan.desktopShortcutPath, { force: true });
  }
  sendProgress(win, 88, 'Registering Arc Power with Windows');
  await writeUninstallRegistration(plan, app.getVersion());
  // Cache is disposable; profiles in plan.profilePath are deliberately never
  // touched, so updates and reinstalls retain the user's durable settings.
  await removeUserDataTree(plan.cachePath);
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

async function scheduleUninstall(plan) {
  const scriptPath = path.join(app.getPath('temp'), `arc-power-uninstall-${process.pid}.ps1`);
  await writeFile(scriptPath, createUninstallCleanupScript({ pid: process.pid, plan, scriptPath }), { encoding: 'utf8', mode: 0o600 });
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(powershellPath(), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ], { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (cause) {
      reject(cause);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      if (!child.pid) {
        reject(new Error('Could not start the Arc Power uninstall helper'));
        return;
      }
      child.unref();
      resolve();
    });
  });
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
  await scheduleUninstall(plan);
  sendProgress(win, 96, 'Removal is in progress; closing setup');
  return { ok: true, scheduled: true, plan };
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
        app.quit();
      }
      return { ok: true };
    },
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
}

export async function runInstallerMode(mode = 'install') {
  await app.whenReady();
  app.setAppUserModelId?.('com.rid.arcpower');
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
