import fsPromises from 'node:fs/promises';
import path from 'node:path';

export const ARC_POWER_APP_USER_MODEL_ID = 'com.rid.arcpower.desktop.v5';
export const ARC_POWER_DEVELOPMENT_APP_USER_MODEL_ID = 'com.rid.arcpower.development';

const PREVIOUS_ARC_POWER_APP_IDS = new Set([
  'com.rid.arcpower',
  'com.rid.arcpower.desktop',
  'com.rid.arcpower.desktop.v2',
  'com.rid.arcpower.desktop.v3',
  'com.rid.arcpower.desktop.v4',
  'com.rid.arcpower.desktop.v5',
]);
const ARC_POWER_EXECUTABLE_NAMES = new Set(['arc power.exe', 'arc-power_portable.exe']);
const ALLOWED_APP_IDS = new Set([ARC_POWER_APP_USER_MODEL_ID]);
const TASKBAR_RELATIVE_PATH = path.join('Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
const IMPLICIT_SHORTCUTS_RELATIVE_PATH = path.join('Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'ImplicitAppShortcuts');
const MAX_DIRECTORIES = 256;
const MAX_SHORTCUTS = 512;

/** Return the ICO-bearing executable for Portable, or the external ICO for an installed app. */
export function resolveTaskbarIconPath({ portableWrapperPath, windowIconPath } = {}) {
  if (typeof portableWrapperPath === 'string' && portableWrapperPath.trim()) return portableWrapperPath;
  return typeof windowIconPath === 'string' && windowIconPath.trim() ? windowIconPath : null;
}

function isReparsePoint(stats) {
  return stats.isSymbolicLink?.() || ((stats.attributes ?? 0) & 0x400) !== 0;
}

function isDirectory(stats) {
  return stats.isDirectory?.() && !isReparsePoint(stats);
}

function isShortcut(stats, name) {
  return stats.isFile?.() && !isReparsePoint(stats) && name.toLowerCase().endsWith('.lnk');
}

function shortcutPathsFromTarget(appDataPath) {
  return [
    path.join(appDataPath, TASKBAR_RELATIVE_PATH),
    path.join(appDataPath, IMPLICIT_SHORTCUTS_RELATIVE_PATH),
  ];
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.trim() !== '' && path.win32.isAbsolute(value);
}

async function hasSafeDirectoryChain(directory, boundary, fs) {
  const relative = path.relative(boundary, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = boundary;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch {
      return false;
    }
    if (!isDirectory(stats)) return false;
  }
  return true;
}

/**
 * Repair only Arc Power's known pinned shortcuts after a normal packaged boot.
 * Callers own that boot gate; this function never starts shell operations itself.
 */
export async function repairArcPowerTaskbarShortcuts({
  appDataPath,
  appId = ARC_POWER_APP_USER_MODEL_ID,
  executablePath,
  iconPath,
  shell,
  fs = fsPromises,
} = {}) {
  const result = { scanned: 0, repaired: 0, skipped: 0, errors: [] };
  if (!isAbsolutePath(appDataPath) || !isAbsolutePath(executablePath) || !isAbsolutePath(iconPath)
    || !ALLOWED_APP_IDS.has(appId) || !shell?.readShortcutLink || !shell?.writeShortcutLink) {
    result.errors.push('Missing required shortcut repair inputs');
    return result;
  }
  if (!ARC_POWER_EXECUTABLE_NAMES.has(path.win32.basename(executablePath).toLowerCase())) {
    result.errors.push('Unrecognized Arc Power executable path');
    return result;
  }

  const visitedDirs = new Set();
  const scannedLinks = new Set();

  async function visitDirectory(directory, depth) {
    if (visitedDirs.size >= MAX_DIRECTORIES || depth > 1 || visitedDirs.has(directory)) return;
    visitedDirs.add(directory);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') result.errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const entry of entries) {
      if (scannedLinks.size >= MAX_SHORTCUTS || visitedDirs.size >= MAX_DIRECTORIES) break;
      const candidate = path.join(directory, entry.name);
      let stats;
      try {
        stats = await fs.lstat(candidate);
      } catch (error) {
        result.errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (isReparsePoint(stats)) {
        result.skipped += 1;
        continue;
      }
      if (isDirectory(stats) && depth < 1) {
        await visitDirectory(candidate, depth + 1);
        continue;
      }
      if (!isShortcut(stats, entry.name) || scannedLinks.has(candidate)) continue;
      scannedLinks.add(candidate);
      result.scanned += 1;
      await repairLink(candidate);
    }
  }

  async function repairLink(shortcutPath) {
    let shortcut;
    try {
      shortcut = shell.readShortcutLink(shortcutPath);
    } catch (error) {
      result.errors.push(`${shortcutPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const appUserModelId = typeof shortcut?.appUserModelId === 'string' ? shortcut.appUserModelId.toLowerCase() : '';
    const targetName = typeof shortcut?.target === 'string' ? path.win32.basename(shortcut.target).toLowerCase() : '';
    if (!PREVIOUS_ARC_POWER_APP_IDS.has(appUserModelId) || !ARC_POWER_EXECUTABLE_NAMES.has(targetName)) {
      result.skipped += 1;
      return;
    }

    try {
      const parentDirectory = path.dirname(shortcutPath);
      const safeRoot = shortcutPathsFromTarget(appDataPath).find((root) => {
        const relative = path.relative(root, shortcutPath);
        return !relative.startsWith('..') && !path.isAbsolute(relative);
      });
      if (!safeRoot || !(await hasSafeDirectoryChain(parentDirectory, appDataPath, fs))) {
        result.skipped += 1;
        return;
      }
      const currentLinkStats = await fs.lstat(shortcutPath);
      if (!isShortcut(currentLinkStats, path.basename(shortcutPath))) {
        result.skipped += 1;
        return;
      }
      const updated = shell.writeShortcutLink(shortcutPath, 'update', {
        ...shortcut,
        icon: iconPath,
        iconIndex: 0,
        appUserModelId: appId,
      });
      if (updated === false) throw new Error('writeShortcutLink returned false');
      result.repaired += 1;
    } catch (error) {
      result.errors.push(`${shortcutPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const directory of shortcutPathsFromTarget(appDataPath)) {
    if (visitedDirs.size >= MAX_DIRECTORIES || scannedLinks.size >= MAX_SHORTCUTS) break;
    if (!(await hasSafeDirectoryChain(directory, appDataPath, fs))) {
      // These per-user shell folders are optional and commonly absent.
      continue;
    }
    await visitDirectory(directory, 0);
  }
  return result;
}
