import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { canonicalExePath, isLikelyGameCandidate, isVerifiedExecutablePath, validateSafeGameCandidate } from './game-candidate.js';
import { deterministicArtworkKey, isValidArtwork, isValidBanner } from './store/game-profile-store.js';

export { canonicalExePath, isLikelyGameCandidate, isVerifiedExecutablePath, validateSafeGameCandidate } from './game-candidate.js';

const execFileAsync = promisify(execFile);

const ARTWORK_RESOLVE_TIMEOUT_MS = 1200;
const ARTWORK_MAX_ITEMS = 64;
const ARTWORK_MAX_BYTES = 4 * 1024 * 1024;
const ARTWORK_CONCURRENCY = 4;
const SCAN_MAX_START_MENU_ITEMS = 256;
const SCAN_MAX_REGISTRY_ITEMS = 512;
const SCAN_MAX_INSTALL_CANDIDATES = 16;
const POSTER_MAX_BYTES = 8 * 1024 * 1024;
const BANNER_DATA_MAX_LENGTH = 12_000_000;
const STEAM_MAX_MANIFESTS = 512;
const STEAM_MAX_USERS = 16;
// Only exact, conventional artwork names are considered. This keeps the
// resolver deterministic without walking arbitrary install contents.
const POSTER_NAMES = ['library_hero', 'library_capsule', 'header', 'banner', 'cover', 'poster', 'capsule', 'steam_grid'];
const POSTER_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const STEAM_ARTWORK_FILES = ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_capsule.jpg', 'header.jpg'];

const withTimeout = (promise, timeoutMs) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
]);

function imagePixelArea(bytes, extension) {
  if (bytes.length >= 24 && extension === '.png'
    && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  }
  if (bytes.length >= 30 && (extension === '.jpg' || extension === '.jpeg') && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return bytes.readUInt16BE(offset + 5) * bytes.readUInt16BE(offset + 7);
      }
      offset += 2 + length;
    }
  }
  if (bytes.length >= 30 && extension === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.toString('ascii', 12, 16) === 'VP8X') {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return width * height;
    }
  }
  return 0;
}

async function chooseBestArtwork(candidates, maxBytes) {
  const accepted = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const bytes = await readFile(candidate.filePath);
      if (bytes.length === 0 || bytes.length > maxBytes) continue;
      accepted.push({ ...candidate, bytes, area: imagePixelArea(bytes, candidate.extension) , index });
    } catch { /* optional artwork item */ }
  }
  accepted.sort((a, b) => {
    if (a.area > 0 || b.area > 0) {
      if (a.area !== b.area) return b.area - a.area;
      if (a.bytes.length !== b.bytes.length) return b.bytes.length - a.bytes.length;
    }
    return a.index - b.index;
  });
  const selected = accepted[0];
  return selected ? `data:${selected.mime};base64,${selected.bytes.toString('base64')}` : null;
}

function candidateScore(item, row) {
  const base = path.win32.basename(item.exePath, '.exe').toLowerCase();
  const display = item.displayName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const baseWords = base.replace(/[^a-z0-9]+/g, ' ').trim();
  let score = row?.source === 'registry' ? 20 : 0;
  if (baseWords === display || display.startsWith(`${baseWords} `)) score += 1000;
  if (/\\game\\/i.test(item.exePath)) score += 100;
  if (/\\bin\\(?:x64|win64)\\/i.test(item.exePath)) score += 40;
  if (/(?:client|ux|render|service|helper|tray|runtime|bootstrap|launcher|crash|report|setup|assistant)$/i.test(base)) score -= 300;
  return score;
}

export function normalizeScannedApps(rows, excludedPaths = [], opts = {}) {
  const excluded = new Set(excludedPaths.map(canonicalExePath).filter(Boolean));
  const apps = [];
  const byDisplay = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const exePath = canonicalExePath(row?.exePath ?? row?.ExecutablePath);
    const executableName = exePath ? path.win32.basename(exePath) : '';
    // A packaged Arc Power process is excluded by its exact path below; the
    // basename guard also covers a restarted packaged copy whose process path
    // is not available to the scanner fixture.
    if (!exePath || !isVerifiedExecutablePath(exePath) || excluded.has(exePath) || !validateSafeGameCandidate(exePath, { excludedPaths, requireExists: opts.requireExists === true })) continue;
    const processName = typeof (row?.processName ?? row?.Name) === 'string'
      ? (row.processName ?? row.Name).trim().slice(0, 260) : path.win32.basename(exePath);
    const explicitDisplayName = typeof row?.displayName === 'string' && row.displayName.trim().length > 0;
    const displayNameRaw = typeof row?.displayName === 'string' && row.displayName.trim()
      ? row.displayName.trim()
      : processName || path.win32.basename(exePath);
    // The UI verifier feeds synthetic executable fixtures through the same
    // scan channel. They are explicitly trusted by the mock adapter, while
    // all real scan rows still pass the conservative game-title/path gate.
    const trustedFixture = row?.source === 'fixture';
    if (opts.onlyGames === true && !trustedFixture && !isLikelyGameCandidate({ exePath, displayName: displayNameRaw, processName })) continue;
    const existing = apps.find((item) => item.exePath === exePath);
    const normalized = {
      exePath,
      processName: processName || path.win32.basename(exePath),
      // Preserve the process/display casing for the UI.  `exePath` is the
      // only canonical identity and remains lowercase by design.
      displayName: displayNameRaw.replace(/\.exe$/i, ''),
      artwork: isValidArtwork(row?.artwork)
        ? row.artwork : deterministicArtworkKey(exePath),
      banner: isValidBanner(row?.banner) ? row.banner : null,
      source: 'scan',
    };
    if (existing) {
      Object.assign(existing, {
        processName: existing.processName || normalized.processName,
        displayName: explicitDisplayName ? normalized.displayName : existing.displayName,
        artwork: isValidArtwork(existing.artwork) && !/^fallback-/.test(existing.artwork) ? existing.artwork : normalized.artwork,
        banner: isValidBanner(existing.banner) ? existing.banner : normalized.banner,
      });
    } else {
      const displayKey = normalized.displayName.toLocaleLowerCase();
      const sameDisplay = byDisplay.get(displayKey);
      if (sameDisplay && candidateScore(normalized, row) <= candidateScore(sameDisplay, sameDisplay.__sourceRow)) continue;
      if (sameDisplay) {
        const index = apps.indexOf(sameDisplay);
        if (index >= 0) apps.splice(index, 1);
      }
      Object.defineProperty(normalized, '__sourceRow', { value: row, enumerable: false });
      byDisplay.set(displayKey, normalized);
      apps.push(normalized);
    }
  }
  return apps.sort((a, b) => `${a.displayName}\0${a.exePath}`.localeCompare(`${b.displayName}\0${b.exePath}`, undefined, { sensitivity: 'base' }));
}

/** Resolve optional poster art without recursively scanning a game install. */
export async function findGamePosterArtwork(exePath, opts = {}) {
  const canonical = canonicalExePath(exePath);
  if (!canonical) return null;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, opts.maxBytes) : POSTER_MAX_BYTES;
  const directories = [];
  let directory = path.win32.dirname(canonical);
  for (let depth = 0; depth < 3; depth += 1) {
    if (!directories.includes(directory)) directories.push(directory);
    const parent = path.win32.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const candidates = [];
  for (const dir of directories) {
    for (const base of POSTER_NAMES) {
      for (const [extension, mime] of POSTER_EXTENSIONS) {
        candidates.push({ filePath: path.win32.join(dir, base + extension), extension, mime });
      }
    }
  }
  const local = await chooseBestArtwork(candidates, maxBytes);
  if (local) return local;
  // Steam keeps high-resolution library art in local appcache/userdata rather
  // than beside the executable. Resolve the AppID from the local manifest,
  // then prefer local cache art. Network artwork is intentionally excluded:
  // this feature is a local catalog cache and must not turn a refresh into a
  // network scan or remote-content fetch.
  const steam = await steamContext(canonical);
  if (steam) {
    const localCandidates = [];
    const libraryCache = path.win32.join(steam.root, 'appcache', 'librarycache');
    for (const name of STEAM_ARTWORK_FILES) localCandidates.push(path.win32.join(libraryCache, `${steam.appId}_${name}`));
    try {
      const users = await readdir(path.win32.join(steam.root, 'userdata'), { withFileTypes: true });
      for (const user of users.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, STEAM_MAX_USERS)) {
        for (const name of ['.png', '.jpg', '.jpeg', '.webp']) {
          localCandidates.push(path.win32.join(steam.root, 'userdata', user.name, 'config', 'grid', `${steam.appId}p${name}`));
        }
      }
    } catch { /* optional Steam cache */ }
    const steamArtwork = await chooseBestArtwork(localCandidates.map((filePath) => {
      const extension = path.win32.extname(filePath).toLowerCase();
      return { filePath, extension, mime: POSTER_EXTENSIONS.get(extension) };
    }).filter((candidate) => candidate.mime), maxBytes);
    if (steamArtwork) return steamArtwork;
  }
  return null;
}

// Keep the old export name for existing callers while exposing the intent of
// the local-banner path to future catalog consumers.
export const findGameBannerArtwork = findGamePosterArtwork;

async function steamContext(canonical) {
  const match = canonical.match(/^(.*\\steamapps)\\common\\([^\\]+)(?:\\.*)?$/i);
  if (!match) return null;
  const steamapps = match[1];
  const installDir = match[2].toLocaleLowerCase();
  let entries;
  try { entries = await readdir(steamapps); } catch { return null; }
  const manifests = entries.filter((entry) => /^appmanifest_\d+\.acf$/i.test(entry)).sort().slice(0, STEAM_MAX_MANIFESTS);
  for (const entry of manifests) {
    const appId = entry.match(/^appmanifest_(\d+)\.acf$/i)?.[1];
    try {
      const manifest = await readFile(path.win32.join(steamapps, entry), 'utf8');
      const name = manifest.match(/"installdir"\s+"([^"]+)"/i)?.[1]?.toLocaleLowerCase();
      if (name === installDir) return { appId, root: path.win32.dirname(steamapps) };
    } catch { /* ignore unreadable manifest */ }
  }
  return null;
}

export async function enrichScannedApps(apps, getArtwork, opts = {}) {
  if (!Array.isArray(apps) || (typeof getArtwork !== 'function' && typeof opts.getBanner !== 'function')) return apps;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs) : ARTWORK_RESOLVE_TIMEOUT_MS;
  const maxItems = Number.isInteger(opts.maxItems) ? Math.max(0, opts.maxItems) : ARTWORK_MAX_ITEMS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(0, opts.maxBytes) : ARTWORK_MAX_BYTES;
  const concurrency = Number.isInteger(opts.concurrency) ? Math.max(1, opts.concurrency) : ARTWORK_CONCURRENCY;
  const out = apps.slice();
  let next = 0;
  let artworkBytes = 0;
  let bannerBytes = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= Math.min(apps.length, maxItems)) return;
      const item = apps[index];
      try {
        const [artwork, banner] = await Promise.all([
          typeof getArtwork === 'function' ? withTimeout(Promise.resolve(getArtwork(item.exePath)), timeoutMs) : item.artwork,
          typeof opts.getBanner === 'function' ? withTimeout(Promise.resolve(opts.getBanner(item.exePath)), timeoutMs) : item.banner,
        ]);
        const nextItem = { ...item };
        if (isValidArtwork(artwork) && artworkBytes + artwork.length <= maxBytes) {
          artworkBytes += artwork.length;
          nextItem.artwork = artwork;
        }
        if (typeof opts.getBanner === 'function') {
          const bannerMaxBytes = Number.isFinite(opts.bannerMaxBytes) ? Math.max(0, opts.bannerMaxBytes) : BANNER_DATA_MAX_LENGTH;
          if (isValidBanner(banner) && bannerBytes + banner.length <= bannerMaxBytes) {
            bannerBytes += banner.length;
            nextItem.banner = banner;
          } else {
            // A refresh is also cache invalidation: a missing/invalid local
            // file must clear a previously resolved banner.
            nextItem.banner = null;
          }
        }
        out[index] = nextItem;
      } catch { /* deterministic fallback remains */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, maxItems, apps.length)) }, worker));
  return out;
}

export function createGameScanAdapter(opts = {}) {
  const executable = opts.executable ?? 'powershell.exe';
  const excluded = [process.execPath, ...(opts.excludedPaths ?? [])];
  return {
    onlyGames: true,
    async scan() {
      // This script is deliberately read-only. It reads shortcut/registry
      // metadata and verifies candidate files; it never reads or invokes an
      // UninstallString, and no discovered path is executed.
      const script = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = [System.Collections.Generic.List[object]]::new()
function Add-VerifiedRow([string]$path, [string]$name, [string]$source) {
  if (-not $path) { return }
  $expanded = [Environment]::ExpandEnvironmentVariables($path.Trim().Trim('"'))
  if (-not [IO.Path]::IsPathFullyQualified($expanded) -or [IO.Path]::GetExtension($expanded) -ne '.exe') { return }
  if (-not (Test-Path -LiteralPath $expanded -PathType Leaf)) { return }
  $item = Get-Item -LiteralPath $expanded
  if (-not $item -or $item.Extension -ne '.exe') { return }
  $rows.Add([pscustomobject]@{ exePath=$item.FullName; displayName=$name; processName=$item.Name; source=$source })
}

# Installed applications from the two standard uninstall hives. Only
# DisplayName, InstallLocation, DisplayIcon and DisplayVersion are read.
$uninstallRoots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$registryCount = 0
foreach ($root in $uninstallRoots) {
  foreach ($app in @(Get-ItemProperty -Path $root)) {
    if ($registryCount -ge ${SCAN_MAX_REGISTRY_ITEMS}) { break }
    $registryCount++
    $display = [string]$app.DisplayName
    if (-not $display) { continue }
    $icon = [string]$app.DisplayIcon
    if ($icon) { Add-VerifiedRow (($icon -split ',')[0]) $display 'registry' }
    $install = [Environment]::ExpandEnvironmentVariables(([string]$app.InstallLocation).Trim('"'))
    if ($install -and (Test-Path -LiteralPath $install -PathType Container)) {
      foreach ($candidate in @(Get-ChildItem -LiteralPath $install -Filter '*.exe' -File -Recurse -Depth 2 | Select-Object -First ${SCAN_MAX_INSTALL_CANDIDATES})) {
        Add-VerifiedRow $candidate.FullName $display 'registry'
      }
    }
  }
}

# Start-menu shortcuts are a useful source for games that do not publish an
# uninstall entry. WScript.Shell only resolves the .lnk metadata; it does not
# run the target. Bound both roots and item count to keep scans predictable.
$shortcutRoots = @(
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')
)
$shortcutCount = 0
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutRoot in $shortcutRoots) {
  foreach ($lnk in @(Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -File -Recurse -Depth 4 | Select-Object -First ${SCAN_MAX_START_MENU_ITEMS})) {
    if ($shortcutCount -ge ${SCAN_MAX_START_MENU_ITEMS}) { break }
    $shortcutCount++
    $shortcut = $shell.CreateShortcut($lnk.FullName)
    Add-VerifiedRow $shortcut.TargetPath ([IO.Path]::GetFileNameWithoutExtension($lnk.Name)) 'start-menu'
  }
}

# Running processes remain a fallback for portable games and apps with no
# registration or shortcut. Executable paths are verified in the same helper.
foreach ($process in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.Name -like '*.exe' } | Select-Object -First ${SCAN_MAX_REGISTRY_ITEMS})) {
  Add-VerifiedRow $process.ExecutablePath ([IO.Path]::GetFileNameWithoutExtension($process.Name)) 'process'
}
      $rows | ConvertTo-Json -Compress
`;
      try {
        const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        const apps = normalizeScannedApps(Array.isArray(parsed) ? parsed : [parsed], excluded, { requireExists: true, onlyGames: true });
        if (typeof opts.getArtwork !== 'function' && typeof opts.getBanner !== 'function') return { apps };
        const enriched = await enrichScannedApps(apps, opts.getArtwork, { ...(opts.artworkBudget ?? {}), getBanner: opts.getBanner });
        return { apps: enriched };
      } catch (err) {
        return { apps: [], error: `Game scan unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
