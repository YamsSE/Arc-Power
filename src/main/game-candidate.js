import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// These are commonly helper, update, crash, uninstall, or launcher binaries.
// New catalog candidates remain conservative and avoid these names.
const UNSAFE_CANDIDATE_RE = /^(?:uninstall(?:er|helper)?|unins\d*|crash(?:report)?|(?:error|wer)report|update(?:r)?|launcher|bootstrapper|setup|install|adapter[_-]?info|detectarchitecture|directstoragecollector|dxinfo|storage(?:reader)?|systeminfo(?:helper|setupassistant)?)\.exe$/i;

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
  return !!canonical && !UNSAFE_CANDIDATE_RE.test(path.win32.basename(canonical));
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
