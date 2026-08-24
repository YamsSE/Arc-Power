import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { canonicalExePath, deterministicArtworkKey, isValidArtwork } from './store/game-profile-store.js';

const execFileAsync = promisify(execFile);

const ARTWORK_RESOLVE_TIMEOUT_MS = 1200;
const ARTWORK_MAX_ITEMS = 64;
const ARTWORK_MAX_BYTES = 4 * 1024 * 1024;
const ARTWORK_CONCURRENCY = 4;

const withTimeout = (promise, timeoutMs) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
]);

export function normalizeScannedApps(rows, excludedPaths = []) {
  const excluded = new Set(excludedPaths.map(canonicalExePath).filter(Boolean));
  const seen = new Set();
  const apps = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const exePath = canonicalExePath(row?.exePath ?? row?.ExecutablePath);
    const executableName = exePath ? path.win32.basename(exePath) : '';
    // A packaged Arc Power process is excluded by its exact path below; the
    // basename guard also covers a restarted packaged copy whose process path
    // is not available to the scanner fixture.
    if (!exePath || excluded.has(exePath) || /^arc[ ._-]*power(?:\.exe)?$/i.test(executableName) || seen.has(exePath)) continue;
    const processName = typeof (row?.processName ?? row?.Name) === 'string'
      ? (row.processName ?? row.Name).trim().slice(0, 260) : path.win32.basename(exePath);
    const displayNameRaw = typeof row?.displayName === 'string' && row.displayName.trim()
      ? row.displayName.trim()
      : processName || path.win32.basename(exePath);
    seen.add(exePath);
    apps.push({
      exePath,
      processName: processName || path.win32.basename(exePath),
      // Preserve the process/display casing for the UI.  `exePath` is the
      // only canonical identity and remains lowercase by design.
      displayName: displayNameRaw.replace(/\.exe$/i, ''),
      artwork: isValidArtwork(row?.artwork)
        ? row.artwork : deterministicArtworkKey(exePath),
      source: 'scan',
    });
  }
  return apps.sort((a, b) => `${a.displayName}\0${a.exePath}`.localeCompare(`${b.displayName}\0${b.exePath}`, undefined, { sensitivity: 'base' }));
}

export async function enrichScannedApps(apps, getArtwork, opts = {}) {
  if (!Array.isArray(apps) || typeof getArtwork !== 'function') return apps;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs) : ARTWORK_RESOLVE_TIMEOUT_MS;
  const maxItems = Number.isInteger(opts.maxItems) ? Math.max(0, opts.maxItems) : ARTWORK_MAX_ITEMS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(0, opts.maxBytes) : ARTWORK_MAX_BYTES;
  const concurrency = Number.isInteger(opts.concurrency) ? Math.max(1, opts.concurrency) : ARTWORK_CONCURRENCY;
  const out = apps.slice();
  let next = 0;
  let artworkBytes = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= Math.min(apps.length, maxItems)) return;
      const item = apps[index];
      try {
        const artwork = await withTimeout(Promise.resolve(getArtwork(item.exePath)), timeoutMs);
        if (isValidArtwork(artwork) && artworkBytes + artwork.length <= maxBytes) {
          artworkBytes += artwork.length;
          out[index] = { ...item, artwork };
        }
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
    async scan() {
      const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.Name -like '*.exe' } | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress";
      try {
        const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        const apps = normalizeScannedApps(Array.isArray(parsed) ? parsed : [parsed], excluded);
        if (typeof opts.getArtwork !== 'function') return { apps };
        const enriched = await enrichScannedApps(apps, opts.getArtwork, opts.artworkBudget);
        return { apps: enriched };
      } catch (err) {
        return { apps: [], error: `Game scan unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}
