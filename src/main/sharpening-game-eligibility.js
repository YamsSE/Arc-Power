import { canonicalExePath, isKnownNonGameExecutable } from './game-candidate.js';
import { normalizeScannedApps } from './game-scan.js';

/** Recognize foreground games without requiring a prior visit to Profiles. */
export function createSharpeningGameLookup({ gameProfiles, gameScan, warn = console.warn }) {
  let discovery = null;
  return async (exePath) => {
    const key = canonicalExePath(exePath);
    if (!key || isKnownNonGameExecutable(key)) return false;
    // The store keeps a lightweight path Set, invalidated by catalog writes.
    // Do not read/parse the artwork-bearing catalog for each foreground poll.
    if (await gameProfiles.hasCatalogPath(key)) return true;
    if (!discovery) {
      discovery = (async () => {
        const result = await gameScan.scan();
        const apps = normalizeScannedApps(result?.apps ?? [], [], { onlyGames: true });
        // This opportunistic discovery can be incomplete. Merge it so saved
        // settings for existing games survive missing sources or scan errors.
        await gameProfiles.syncCatalog(apps);
      })().catch((error) => {
        warn(`[sharpening] game catalog scan failed; capture remains disabled: ${error?.message ?? String(error)}`);
      });
    }
    await discovery;
    return await gameProfiles.hasCatalogPath(key);
  };
}
