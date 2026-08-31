import fs from 'node:fs';
import path from 'node:path';

function randomNumber(random = Math.random) {
  const value = Number(random());
  return Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : Math.random();
}

export function recordingScreenshotFileName(random = Math.random) {
  return `Arc Screenshot ${100 + Math.floor(randomNumber(random) * 900)}.png`;
}

export function collisionSafeRecordingScreenshotPath(root, { exists = () => false, random = Math.random, maxAttempts = 900 } = {}) {
  const base = path.resolve(root);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = path.join(base, recordingScreenshotFileName(random));
    if (!exists(candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique screenshot filename');
}

function numericHandleFromSourceId(value) {
  const match = String(value ?? '').match(/(?:window|screen):([0-9]+)/i);
  if (!match) return 0;
  const handle = Number(match[1]);
  return Number.isSafeInteger(handle) ? handle : 0;
}

export function recordingScreenshotSourceMatches(source, target) {
  if (!source || !target) return false;
  if (target.type === 'window') {
    return numericHandleFromSourceId(source.id) === Number(target.windowHandle)
      || (typeof target.windowTitle === 'string' && target.windowTitle.trim() !== '' && source.name === target.windowTitle);
  }
  const displayId = String(target.displayId ?? '').trim();
  if (!displayId || displayId === 'primary') return false;
  return String(source.display_id ?? '').trim().toLowerCase() === displayId.toLowerCase()
    || String(source.name ?? '').trim().toLowerCase() === displayId.toLowerCase();
}

function primaryScreenSource(sources) {
  return sources.find((source) => String(source?.id ?? '').toLowerCase().startsWith('screen:')) ?? null;
}

/**
 * Capture the selected display/window thumbnail supplied by Electron and
 * write it as a PNG. Electron owns the desktop-capture permission boundary;
 * this seam only selects the already-authorized source and performs the
 * atomic file write in the main process.
 */
export async function captureRecordingScreenshot({ desktopCapturer, target, outputPath, fsModule = fs, thumbnailSize = { width: 3840, height: 2160 } } = {}) {
  if (!desktopCapturer?.getSources) throw new Error('Desktop capture is unavailable');
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) throw new Error('Screenshot output path must be absolute');
  const type = target?.type === 'window' ? 'window' : 'screen';
  const sources = await desktopCapturer.getSources({ types: [type], thumbnailSize, fetchWindowIcons: false });
  let source = sources.find((item) => recordingScreenshotSourceMatches(item, target));
  if (!source && type === 'screen') source = primaryScreenSource(sources);
  if (!source?.thumbnail || source.thumbnail.isEmpty?.()) {
    throw new Error(target?.type === 'window' ? 'The selected window is no longer available.' : 'The selected display is no longer available.');
  }
  fsModule.mkdirSync(path.dirname(outputPath), { recursive: true });
  const png = source.thumbnail.toPNG?.();
  if (!Buffer.isBuffer(png) || png.length === 0) throw new Error('The selected capture source returned no image.');
  fsModule.writeFileSync(outputPath, png, { flag: 'wx' });
  return outputPath;
}
