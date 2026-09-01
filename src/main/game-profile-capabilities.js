import path from 'node:path';

// Keep this deliberately small and executable-name based. XeSS support in a
// game is not enough to prove that the game integrates XeSS Frame Generation;
// unknown names therefore remain unsupported until explicitly added here.
export const XESS_FG_ALLOWLIST = Object.freeze([
  'acshadows.exe',
  'cyberpunk2077.exe',
  'f1_24.exe',
  'f1_24_dx12.exe',
  'f1_25.exe',
  'hogwartslegacy.exe',
  'robocoproguecity-win64-shipping.exe',
  'starwarsoutlaws.exe',
]);

const XESS_FG_ALLOWLIST_SET = new Set(XESS_FG_ALLOWLIST);
const EXPLICITLY_INELIGIBLE_RE = /(?:3dmark|benchmark|benchmate|furmark|unigine|superposition|heaven|valley|occt|cinebench|aida64|gpu[-_ ]?z|hwinfo|afterburner|presentmon|blender|stress|(?:^|[-_. ])(?:steam|discord|chrome|firefox|edge|explorer|launcher|setup|install|update|uninstall|crash|overlay|service)(?:[-_. ]|$))/i;

const UNKNOWN_REASON = 'XeFG is available only for executables in the known XeSS Frame Generation allowlist.';
const INELIGIBLE_REASON = 'XeFG is not applicable to benchmark or software executables.';
const INVALID_REASON = 'XeFG requires a valid executable path.';

/**
 * Pure executable gate for per-game XeSS Frame Generation settings.
 * @param {unknown} exePath
 * @returns {{ supported: boolean, reason: string|null }}
 */
export function classifyXeFgExecutable(exePath) {
  if (typeof exePath !== 'string' || !exePath.trim() || !/\.exe$/i.test(exePath.trim())) {
    return { supported: false, reason: INVALID_REASON };
  }
  const basename = path.win32.basename(exePath.trim()).toLowerCase();
  if (!basename || EXPLICITLY_INELIGIBLE_RE.test(basename)) {
    return { supported: false, reason: INELIGIBLE_REASON };
  }
  if (!XESS_FG_ALLOWLIST_SET.has(basename)) {
    return { supported: false, reason: UNKNOWN_REASON };
  }
  return { supported: true, reason: null };
}
