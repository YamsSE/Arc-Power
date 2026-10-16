import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Pinned custom source build of ReShade v6.8.0; see sharpening-runtime/ provenance.
export const RESHADE_DLL_SHA256 = '6bc058489a00cc3a6ce72425a7fbe491aa4f4c1cd169b752af9e08261ccb9c13';
const BUNDLED_PATH = fileURLToPath(new URL('./sharpening-runtime/ArcPower.ReShade64.dll', import.meta.url))
  .replace(/app\.asar(?=[\\/]|$)/i, 'app.asar.unpacked');

/** Offline only: never downloads, executes an installer, or loads the DLL into Arc Power. */
export function createReShadeRuntimeProvider({ filePath = BUNDLED_PATH, expectedSha256 = RESHADE_DLL_SHA256 } = {}) {
  if (!path.isAbsolute(filePath) || !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new TypeError('Invalid bundled sharpening runtime identity.');
  const readVerified = () => {
    let stat;
    try { stat = fs.lstatSync(filePath); }
    catch { throw new Error('The included sharpening runtime is missing. Reinstall Arc Power.'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size < 64 || stat.size > 32 * 1024 * 1024) {
      throw new Error('The included sharpening runtime is damaged or redirected. Reinstall Arc Power.');
    }
    const bytes = fs.readFileSync(filePath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== expectedSha256.toLowerCase()) throw new Error('The included sharpening runtime failed its integrity check. Reinstall Arc Power.');
    return bytes;
  };
  const provider = async () => readVerified();
  provider.isReady = () => { try { readVerified(); return true; } catch { return false; } };
  return provider;
}
