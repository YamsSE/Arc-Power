import fs from 'node:fs';
import path from 'node:path';
import { canonicalExePath } from './game-candidate.js';

const MANIFEST = 'reshade-managed-games.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANAGED_GAMES = 256;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Read the previous ReShade ownership manifest without touching game files. */
export function inspectLegacySharpening(dir, fsApi = fs) {
  const manifestPath = path.join(dir, MANIFEST);
  try {
    const stat = fsApi.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_MANIFEST_BYTES) {
      throw new Error('The previous sharpening manifest is linked, oversized, or not a regular file.');
    }

    const records = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    if (!plainObject(records) || Object.keys(records).length > MAX_MANAGED_GAMES) {
      throw new Error('The previous sharpening manifest has an unsupported shape.');
    }

    const games = [];
    for (const [key, entry] of Object.entries(records)) {
      if (!plainObject(entry) || typeof entry.exePath !== 'string'
        || canonicalExePath(entry.exePath) !== key || entry.exePath.toLowerCase() !== key
        || !['direct', 'optiscaler'].includes(entry.mode) || !plainObject(entry.ownedFiles)) {
        throw new Error('The previous sharpening manifest contains an invalid ownership record.');
      }
      const gameDir = path.dirname(entry.exePath);
      const runtimeName = entry.mode === 'direct' ? 'dxgi.dll' : 'ReShade64.dll';
      const expected = [
        path.join(gameDir, runtimeName),
        path.join(gameDir, 'ReShade.ini'),
        path.join(gameDir, 'ArcPowerSharpening', 'ArcPowerSharpen.fx'),
        path.join(gameDir, 'ArcPowerSharpening', 'preset.ini'),
      ].map((item) => path.resolve(item).toLowerCase()).sort();
      const owned = Object.entries(entry.ownedFiles);
      if (owned.length !== expected.length
        || owned.some(([file, hash]) => !path.isAbsolute(file) || !/^[a-f0-9]{64}$/i.test(hash))
        || owned.map(([file]) => path.resolve(file).toLowerCase()).sort().join('\n') !== expected.join('\n')) {
        throw new Error('The previous sharpening manifest contains invalid owned-file records.');
      }
      games.push({ exePath: entry.exePath, mode: entry.mode });
    }

    games.sort((a, b) => a.exePath.localeCompare(b.exePath));
    return { status: games.length ? 'found' : 'clear', manifestPath, games };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'clear', manifestPath, games: [] };
    return { status: 'unreadable', manifestPath, games: [], reason: error.message };
  }
}
