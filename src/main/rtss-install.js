// Arc Power - optional RTSS installer integration.
//
// RTSS is third-party software and is not bundled into Arc Power. The custom
// Arc Power installer can, when the user leaves the option enabled, install
// the exact WinGet package published for RTSS. The package manager owns the
// download, signature/hash checks, and RTSS's own setup UI; Arc Power only
// verifies the result and continues gracefully when WinGet is unavailable.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const RTSS_WINGET_ID = 'Guru3D.RTSS';
export const RTSS_WINGET_ARGS = Object.freeze([
  'install',
  '--id', RTSS_WINGET_ID,
  '--exact',
  '--silent',
  '--accept-package-agreements',
  '--accept-source-agreements',
]);

const RTSS_WINGET_LIST_ARGS = Object.freeze([
  'list',
  '--id', RTSS_WINGET_ID,
  '--exact',
  '--accept-source-agreements',
  '--disable-interactivity',
]);

const RTSS_WINGET_NAME_LIST_ARGS = Object.freeze([
  'list',
  '--name', 'RivaTuner Statistics Server',
  '--exact',
  '--accept-source-agreements',
  '--disable-interactivity',
]);

const defaultExecFile = promisify(execFile);
const RTSS_EXE_NAME = 'RTSS.exe';

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

/** Return the normal machine/user locations used by RTSS installers. */
export function knownRtssExecutablePaths(env = process.env) {
  const roots = unique([
    env?.['ProgramFiles(x86)'],
    env?.ProgramFiles,
    env?.LOCALAPPDATA,
  ]);
  return unique(roots.map((root) => path.join(root, 'RivaTuner Statistics Server', RTSS_EXE_NAME)));
}

export function outputMentionsRtss(output) {
  return /Guru3D\.RTSS|RivaTuner\s+Statistics\s+Server/i.test(String(output ?? ''));
}

function errorText(error) {
  const text = [error?.stderr, error?.stdout, error?.message]
    .map((value) => String(value ?? '').trim())
    .find((value) => value.length > 0) ?? 'WinGet did not complete the RTSS installation.';
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

/**
 * Check whether RTSS is already installed without downloading anything.
 * Filesystem detection handles normal installations immediately; WinGet's
 * local package inventory covers a custom install location.
 */
export async function detectRtssInstallation({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  execFileAsync = defaultExecFile,
} = {}) {
  if (platform !== 'win32') return { installed: false, source: 'windows-only' };
  if (knownRtssExecutablePaths(env).some((filePath) => {
    try { return exists(filePath); } catch { return false; }
  })) return { installed: true, source: 'filesystem' };

  for (const args of [RTSS_WINGET_LIST_ARGS, RTSS_WINGET_NAME_LIST_ARGS]) {
    try {
      const result = await execFileAsync('winget.exe', args, { windowsHide: true, timeout: 7_000, maxBuffer: 512 * 1024 });
      if (outputMentionsRtss(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`)) {
        return { installed: true, source: 'winget' };
      }
    } catch (cause) {
      // A missing WinGet alias or an offline source is not an Arc Power error;
      // the installer can still offer the optional install step below. A
      // package-ID no-match can still be found by the display-name query, so
      // only stop early when WinGet itself cannot be started or is stuck.
      if (cause?.code === 'ENOENT' || cause?.code === 'ETIMEDOUT') break;
    }
  }
  return { installed: false, source: 'not-found' };
}

/**
 * Install RTSS through WinGet and verify that it is visible afterwards.
 * Failure is reported as an optional dependency result so Arc Power itself
 * still installs and its DXGI fallback remains usable.
 */
export async function installRtss({
  platform = process.platform,
  detect = detectRtssInstallation,
  execFileAsync = defaultExecFile,
} = {}) {
  if (platform !== 'win32') return { ok: false, installed: false, skipped: true, reason: 'windows-only' };
  const before = await detect({ platform, execFileAsync });
  if (before.installed) return { ok: true, installed: true, alreadyInstalled: true, source: before.source };

  try {
    await execFileAsync('winget.exe', RTSS_WINGET_ARGS, {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
  } catch (cause) {
    return {
      ok: false,
      installed: false,
      reason: 'install-failed',
      detail: errorText(cause),
    };
  }

  const after = await detect({ platform, execFileAsync });
  if (after.installed) return { ok: true, installed: true, source: after.source };
  return {
    ok: false,
    installed: false,
    reason: 'verification-failed',
    detail: 'WinGet completed without exposing an installed RTSS package.',
  };
}
