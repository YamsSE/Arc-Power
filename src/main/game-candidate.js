import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// These are commonly helper, update, crash, uninstall, or launcher binaries.
// New catalog candidates remain conservative and avoid these names.
const UNSAFE_CANDIDATE_RE = /^(?:uninstall(?:er|helper)?|unins\d*|crash(?:report)?|(?:error|wer)report|update(?:r)?|launcher|bootstrapper|setup|install|adapter[_-]?info|detectarchitecture|directstoragecollector|dxinfo|storage(?:reader)?|systeminfo(?:helper|setupassistant)?)\.exe$/i;

// A scan is allowed to discover executables from the uninstall registry and
// from every running process, so "is an .exe" is not enough to call something
// a game.  Keep this gate deliberately conservative: known game-library roots
// and recognisable game titles are positive evidence; Windows, tooling,
// launchers, overlays and companion services are not.
const GAME_LIBRARY_PATH_RE = /\\(?:steamapps\\common|epic games\\[^\\]+\\(?!directxredist)|gog galaxy\\games|xboxgames|riot games\\[^\\]+\\game|ubisoft(?: game launcher)?\\(?:games|[^\\]+)|battle\.net\\games)\\/i;
const GAME_TITLE_RE = /(?:3dmark|assassin['’]?s creed|crusader kings|final fantasy|league of legends|monster hunter|palworld|\bpeak\b|star wars outlaws|teamfight tactics|valorant|counter[- ]strike|fortnite|apex legends|dota(?: 2)?|elden ring|cyberpunk|grand theft auto|red dead redemption|the witcher|baldur['’]?s gate|diablo|overwatch|destiny|minecraft)/i;
const NON_GAME_RE = /(?:^|[\\/ ._-])(?:7[- ]?zip|administrative tools|aida64|applicationframehost|ascent(?:[-_]gep)?|asrrgbled|backgroundtaskhost|benchmate|charmap|chatgpt|codex|conhost|cpu[- ]?z|crashhelper|crossdevice|dataexchangehost|desktop overlay host|discord|disk cleanup|dismhost|enhancedrpc|explorer|firefox|free download manager|gameinputredistservice|git(?:[- ]|$)|google chrome|hisuite|hwinfo|intel(?:r)? graphics|iscsicpl|lm studio|magnify|microsoft|morepowertool|msiafterburner|msedgewebview2|narrator|node(?:\.exe)?|obs(?: studio)?|opencode|paint\.net|paradox launcher|pawnio|powershell|predatorbifrost|rpcs3|riot client|riotclientservices|rivatuner|roccat|runtimebroker|searchhost|shell(?:experience)?host|snippingtool|steam(?:webhelper)?|systemsettings|task(?:mgr|host)|teamspeak|turtle beach|ubisoft connect|vanguard|wallpaper engine|windows|winrar|xboxpcappft)(?:$|[\\/ ._-])/i;
const LEAGUE_CLIENT_HELPER_RE = /^leagueclientux(?:render)?(?:\.exe)?$/i;

export function canonicalExePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 32768) return null;
  let winPath = trimmed.replaceAll('/', '\\');
  // Reduce the two supported extended drive forms to a normal Win32 path.
  winPath = winPath.replace(/^\\\\[?.]\\(?=[a-z]:\\)/i, '');
  // Device namespaces and extended UNC paths are not safe executable IDs.
  if (/^\\\\(?:[?.]|Device|GlobalRoot)(?:\\|$)/i.test(winPath)) return null;
  const normalized = path.win32.normalize(winPath);
  if ((!/^[a-z]:\\/i.test(normalized) && !normalized.startsWith('\\\\')) || !/\.exe$/i.test(normalized)) return null;
  return normalized.toLowerCase();
}

export function isVerifiedExecutablePath(value) {
  const canonical = canonicalExePath(value);
  const basename = canonical ? path.win32.basename(canonical) : '';
  return !!canonical
    && !UNSAFE_CANDIDATE_RE.test(basename)
    // LeagueClientUX.exe and LeagueClientUxRender.exe are helper processes,
    // not game executables. Keep this exclusion in the shared ingress gate
    // so catalog sync and persisted-catalog sanitization cannot re-admit them
    // when their metadata looks game-like.
    && !LEAGUE_CLIENT_HELPER_RE.test(basename);
}

/**
 * Return true only when metadata has a credible game signal.  This is used
 * for scanner/catalog rows, not for the legacy manual association API: users
 * may still keep an explicitly saved executable association for compatibility.
 */
export function isLikelyGameCandidate({ exePath, displayName = '', processName = '' } = {}) {
  const canonical = canonicalExePath(exePath);
  if (!canonical || !isVerifiedExecutablePath(canonical)) return false;
  if (LEAGUE_CLIENT_HELPER_RE.test(path.win32.basename(canonical))
    || LEAGUE_CLIENT_HELPER_RE.test(String(processName).trim())
    || LEAGUE_CLIENT_HELPER_RE.test(String(displayName).trim())) return false;
  const text = `${canonical} ${String(displayName)} ${String(processName)}`;
  if (NON_GAME_RE.test(text)) {
    // A title such as "League of Legends" or "Crusader Kings III" wins over
    // a generic launcher/service token only when the executable is itself in
    // the game's directory.  This prevents Riot/Ubisoft launcher processes
    // from becoming games while retaining their actual game executables.
    if (!GAME_TITLE_RE.test(`${displayName} ${canonical}`) || !/\\game\\|\\steamapps\\common\\|\\ubisoft\\/i.test(canonical)) return false;
  }
  return GAME_LIBRARY_PATH_RE.test(canonical) || GAME_TITLE_RE.test(`${displayName} ${processName} ${canonical}`);
}

/** Main-process gate for executable identities entering the game catalog. */
export function validateSafeGameCandidate(value, { excludedPaths = [], requireExists = true } = {}) {
  const canonical = canonicalExePath(value);
  if (!canonical || !isVerifiedExecutablePath(canonical)) return null;
  const excluded = [process.execPath, ...excludedPaths]
    .map(canonicalExePath)
    .filter(Boolean);
  const basename = path.win32.basename(canonical);
  if (excluded.includes(canonical) || /^arc[ ._-]*power(?:[ ._-].*)?\.exe$/i.test(basename)) return null;
  if (requireExists) {
    try { if (!fs.statSync(canonical).isFile()) return null; }
    catch { return null; }
  }
  return canonical;
}
