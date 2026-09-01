import fs from 'node:fs';
import path from 'node:path';

// The name list is a safe fallback for known games whose XeFG runtime is
// installed by a launcher, shared runtime, or a non-standard package layout.
// The runtime check below is the primary way to discover newly released games
// without having to ship a title-specific update first.
export const XESS_FG_ALLOWLIST = Object.freeze([
  'acblackflag.exe',
  'acshadows.exe',
  'cyberpunk2077.exe',
  'f1_24.exe',
  'f1_24_dx12.exe',
  'f1_25.exe',
  'hogwartslegacy.exe',
  'outlaws.exe',
  'robocoproguecity-win64-shipping.exe',
]);

const XESS_FG_ALLOWLIST_SET = new Set(XESS_FG_ALLOWLIST);
const XESS_FG_RUNTIME_NAME = 'libxess_fg.dll';
const EXPLICITLY_INELIGIBLE_RE = /(?:3dmark|benchmark|benchmate|furmark|unigine|superposition|heaven|valley|occt|cinebench|aida64|gpu[-_ ]?z|hwinfo|afterburner|presentmon|blender|stress|(?:^|[-_. ])(?:steam|discord|chrome|firefox|edge|explorer|launcher|setup|install|update|uninstall|crash|overlay|service)(?:[-_. ]|$))/i;

const UNKNOWN_REASON = 'XeFG is available only for known XeFG games or executables that ship the XeFG runtime.';
const INELIGIBLE_REASON = 'XeFG is not applicable to benchmark or software executables.';
const INVALID_REASON = 'XeFG requires a valid executable path.';

function hasXeFgRuntimeBesideExecutable(exePath) {
  const directory = path.win32.dirname(exePath);
  if (!directory || directory === '.') return false;
  try {
    return fs.statSync(path.join(directory, XESS_FG_RUNTIME_NAME)).isFile();
  } catch {
    return false;
  }
}

/**
 * Executable gate for per-game XeSS Frame Generation settings.
 *
 * `inspectRuntime` is enabled by the real backend. It recognizes a newly
 * catalogued game when its executable directory contains Intel's XeFG runtime
 * (`libxess_fg.dll`), while the explicit deny list still wins for benchmarks
 * and ordinary software. Leaving it off keeps callers that need a pure,
 * deterministic name-only check (such as the mock backend) deterministic.
 * @param {unknown} exePath
 * @param {{ inspectRuntime?: boolean }} [options]
 * @returns {{ supported: boolean, reason: string|null }}
 */
export function classifyXeFgExecutable(exePath, options = {}) {
  if (typeof exePath !== 'string' || !exePath.trim() || !/\.exe$/i.test(exePath.trim())) {
    return { supported: false, reason: INVALID_REASON };
  }
  const basename = path.win32.basename(exePath.trim()).toLowerCase();
  if (!basename || EXPLICITLY_INELIGIBLE_RE.test(basename)) {
    return { supported: false, reason: INELIGIBLE_REASON };
  }
  if (XESS_FG_ALLOWLIST_SET.has(basename) || (options.inspectRuntime === true && hasXeFgRuntimeBesideExecutable(exePath.trim()))) {
    return { supported: true, reason: null };
  }
  return { supported: false, reason: UNKNOWN_REASON };
}
