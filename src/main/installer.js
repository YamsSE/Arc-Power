// Arc Power custom Windows installer/uninstaller.
//
// The published installer is a portable Electron wrapper with a different
// artifact name. When that wrapper runs, its extracted app directory is the
// current packaged payload, so installation is a normal file copy into the
// user's LocalAppData\Programs directory. The installed executable re-enters
// this module with --uninstall for the matching uninstaller UI.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  powershellLiteral,
  resolveDefaultInstallDir,
} from './installer-pure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const INSTALLER_HTML = path.join(__dirname, '..', 'installer', 'installer.html');
const INSTALLER_PRELOAD = path.join(__dirname, '..', 'installer', 'installer-preload.cjs');
const INSTALLER_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

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
  if (!win.isDestroyed()) win.webContents.send('installer:progress', { percent, message });
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

  sendProgress(win, 8, 'Preparing your Arc Power installation');
  await mkdir(plan.installDir, { recursive: true });
  sendProgress(win, 20, 'Copying the Arc Power application');
  await cp(sourceRoot, plan.installDir, { recursive: true, force: true });
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
    const openError = await shell.openPath(plan.executablePath);
    if (openError) throw new Error(`Arc Power was installed, but could not be launched: ${openError}`);
  }
  return { ok: true, plan, launched: plan.launchAfterInstall };
}

async function scheduleUninstall(plan) {
  const scriptPath = path.join(app.getPath('temp'), `arc-power-uninstall-${process.pid}.ps1`);
  await writeFile(scriptPath, createUninstallCleanupScript({ pid: process.pid, plan, scriptPath }), { encoding: 'utf8', mode: 0o600 });
  const child = spawn(powershellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  if (!child.pid) throw new Error('Could not start the Arc Power uninstall helper');
  child.unref();
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
  await removeUserDataTree(plan.cachePath);
  sendProgress(win, 52, 'Removing shortcuts and Windows registration');
  await scheduleUninstall(plan);
  sendProgress(win, 100, 'Arc Power has been removed');
  return { ok: true, plan };
}

function registerInstallerIpc(win, mode) {
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
    'installer:close': async () => { app.quit(); return { ok: true }; },
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
}

export async function runInstallerMode(mode = 'install') {
  await app.whenReady();
  app.setAppUserModelId?.('com.rid.arcpower');
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
    icon: INSTALLER_ICON,
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
  // Keep a deterministic fallback for environments where ready-to-show is not
  // emitted (for example, a headless/GPU-fallback portable session).
  showInstallerWindow();
  win.on('closed', () => { if (!app.isQuitting) app.quit(); });
}
