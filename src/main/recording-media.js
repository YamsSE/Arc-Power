import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isPathWithinRoot, safeVideoExtension } from './recording-pure.js';

const OPAQUE_CLIP_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MEDIA_STREAM_HIGH_WATER_MARK = 64 * 1024;

function hasSymlinkEscape(root, candidate, fsImpl = fs, { allowMissingLeaf = false } = {}) {
  let current = path.resolve(candidate);
  const rootResolved = path.resolve(root);
  while (isPathWithinRoot(rootResolved, current, { allowRoot: true })) {
    try { if (fsImpl.lstatSync(current).isSymbolicLink()) return true; }
    catch (err) {
      if (!(allowMissingLeaf && err?.code === 'ENOENT')) return true;
    }
    if (current === rootResolved) return false;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

function realpathSync(fsImpl, value) {
  const nativeRealpath = fsImpl.realpathSync?.native;
  return typeof nativeRealpath === 'function' ? nativeRealpath(value) : fsImpl.realpathSync(value);
}

function isReparsePoint(stat) {
  return Boolean(
    stat?.isSymbolicLink?.()
    || stat?.isJunction?.()
    || stat?.isReparsePoint?.()
    || stat?.reparsePoint === true
    || stat?.attributes?.reparsePoint === true,
  );
}

function pathChain(filePath, fsImpl = fs, { allowMissingLeaf = false } = {}) {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  const chain = [];
  let current = resolved;
  while (true) {
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch (err) {
      if (allowMissingLeaf && current === resolved && err?.code === 'ENOENT') return { chain, missingLeaf: true };
      return null;
    }
    // Windows junctions are reparse points even on Node builds where
    // lstat().isSymbolicLink() does not report them. The extra shape checks
    // also make injected platform adapters fail closed by default.
    if (isReparsePoint(stat)) return null;
    let canonical;
    try { canonical = realpathSync(fsImpl, current); } catch { return null; }
    chain.push({ path: current, canonical, stat });
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return { chain, missingLeaf: false };
}

function samePathChain(first, second) {
  if (!first || !second || first.length !== second.length) return false;
  return first.every((item, index) => {
    const other = second[index];
    return item.path === other.path
      && item.canonical === other.canonical
      && sameFileIdentity(item.stat, other.stat);
  });
}

export function resolveSafeRecordingPath(root, relativePath, fsImpl = fs, { allowMissing = false } = {}) {
  if (typeof root !== 'string' || typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null;
  const candidate = path.resolve(root, relativePath);
  if (!isPathWithinRoot(root, candidate) || !safeVideoExtension(candidate) || hasSymlinkEscape(root, candidate, fsImpl, { allowMissingLeaf: allowMissing })) return null;
  if (allowMissing) {
    try { fsImpl.lstatSync(root); }
    catch (err) { return err?.code === 'ENOENT' ? candidate : null; }
  }
  const rootChain = pathChain(root, fsImpl);
  if (!rootChain) return null;
  const candidateChain = pathChain(candidate, fsImpl, { allowMissingLeaf: allowMissing });
  if (!candidateChain) return null;
  if (candidateChain.missingLeaf) return candidate;
  try {
    const stat = fsImpl.statSync(candidate);
    if (!stat.isFile()) return null;
    // From this point on callers use the canonical path, never the logical
    // path that may cross a junction if an ancestor is swapped later. The
    // complete chain is also snapshotted again by openSafeRecordingFile.
    const realRoot = rootChain.chain[0]?.canonical;
    const realCandidate = candidateChain.chain[0]?.canonical;
    return realRoot && realCandidate && isPathWithinRoot(realRoot, realCandidate) ? realCandidate : null;
  } catch (err) { return allowMissing && err?.code === 'ENOENT' ? candidate : null; }
}

function sameFileIdentity(first, second) {
  for (const key of ['dev', 'ino']) {
    if (first?.[key] !== undefined && second?.[key] !== undefined && String(first[key]) !== String(second[key])) return false;
  }
  return true;
}

function isWindowsPlatform(fsImpl) {
  return fsImpl?.platform === 'win32' || process.platform === 'win32';
}

function regularFileStat(stat) {
  return Boolean(stat?.isFile?.()) && !stat?.isSymbolicLink?.();
}

function closeFd(handle, fsImpl) {
  if (!handle || handle.closed) return;
  handle.closed = true;
  try { fsImpl.closeSync(handle.fd); } catch {}
}

/**
 * Open the already-authorized canonical path and prove that every ancestor
 * stayed the same regular, non-reparse object across the open. Node does not
 * expose Windows FILE_FLAG_OPEN_REPARSE_POINT/relative directory handles, so
 * this is the platform-safe stdlib strategy: reject every reparse ancestor,
 * snapshot the full chain immediately around the open, and keep the opened fd
 * for all streaming reads. A swapped ancestor can therefore only fail closed
 * or leave the already-open descriptor pointing at the original file.
 */
export function openSafeRecordingFile(filePath, fsImpl = fs) {
  let before;
  let fd = null;
  try {
    const beforeChain = pathChain(filePath, fsImpl);
    if (!beforeChain || beforeChain.missingLeaf) return null;
    before = beforeChain.chain[0]?.stat;
    if (!regularFileStat(before)) return null;
    const readOnly = fsImpl.constants?.O_RDONLY;
    const noFollow = fsImpl.constants?.O_NOFOLLOW;
    const flags = Number.isInteger(readOnly) ? readOnly | (Number.isInteger(noFollow) ? noFollow : 0) : 'r';
    fd = fsImpl.openSync(filePath, flags);
    const opened = fsImpl.fstatSync(fd);
    if (!regularFileStat(opened) || !sameFileIdentity(before, opened)) {
      try { fsImpl.closeSync(fd); } catch {}
      return null;
    }
    const afterChain = pathChain(filePath, fsImpl);
    const after = afterChain?.chain[0]?.stat;
    if (!afterChain || !samePathChain(beforeChain.chain, afterChain.chain) || !regularFileStat(after) || !sameFileIdentity(after, opened)) {
      try { fsImpl.closeSync(fd); } catch {}
      return null;
    }
    return { fd, stat: opened, closed: false, path: filePath, chain: afterChain.chain };
  } catch {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch {}
    }
    return null;
  }
}

export function revalidateSafeRecordingFile(filePath, handle, fsImpl = fs) {
  if (!handle || handle.closed) return false;
  try {
    const opened = fsImpl.fstatSync(handle.fd);
    const currentChain = pathChain(filePath, fsImpl);
    const current = currentChain?.chain[0]?.stat;
    return Boolean(currentChain)
      && samePathChain(handle.chain, currentChain.chain)
      && regularFileStat(opened)
      && regularFileStat(current)
      && sameFileIdentity(opened, current);
  } catch { return false; }
}

/**
 * Delete only after the same full ancestor chain and leaf identity have been
 * revalidated. Windows path-based unlink is deliberately disabled: Node does
 * not expose a bound, no-follow delete relative to the authorized directory
 * handles, so an ancestor can still be swapped after revalidation. The caller
 * must pass the handle returned by openSafeRecordingFile; deleting an
 * un-opened path is intentionally not supported by this privileged seam.
 */
export function unlinkSafeRecordingFile(filePath, handle, fsImpl = fs) {
  if (!revalidateSafeRecordingFile(filePath, handle, fsImpl)) return { ok: false, reason: 'unsafe-path' };
  if (isWindowsPlatform(fsImpl)) return { ok: false, reason: 'unsupported-platform' };
  try {
    fsImpl.unlinkSync(filePath);
    try {
      fsImpl.lstatSync(filePath);
      return { ok: false, reason: 'unsafe-path' };
    } catch (err) {
      return err?.code === 'ENOENT' ? { ok: true, reason: null } : { ok: false, reason: 'delete-failed' };
    }
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'not-found' : 'delete-failed' };
  }
}

export function closeSafeRecordingFile(handle, fsImpl = fs) {
  closeFd(handle, fsImpl);
}

export function mediaClipUrl(id) {
  if (!isOpaqueClipId(id)) return null;
  return `arc-power-media://clip/${encodeURIComponent(id)}`;
}

export function isOpaqueClipId(id) {
  return typeof id === 'string' && OPAQUE_CLIP_ID.test(id);
}

export function mediaRequestPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'arc-power-media:' || parsed.hostname !== 'clip') return null;
    const id = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return isOpaqueClipId(id) ? id : null;
  } catch { return null; }
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (typeof headers === 'object') {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return typeof value === 'string' ? value : String(value);
    }
  }
  return null;
}

/**
 * Parse one RFC 7233 byte range. Multiple ranges are deliberately rejected:
 * the media protocol only needs one bounded stream per video request.
 */
export function parseByteRange(value, size) {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'invalid' };
  if (value == null || String(value).trim() === '') {
    return { kind: 'full', start: 0, end: Math.max(0, size - 1) };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || size === 0 || (!match[1] && !match[2])) return { kind: 'invalid' };
  const startText = match[1];
  const endText = match[2];
  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start) || start >= size) return { kind: 'invalid' };
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(end) || end < start) return { kind: 'invalid' };
    end = Math.min(end, size - 1);
  }
  return { kind: 'range', start, end };
}

function mediaContentType(filePath) {
  switch (safeVideoExtension(filePath)) {
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.mkv': return 'video/x-matroska';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}

function streamBody(stream) {
  return typeof Readable.toWeb === 'function' ? Readable.toWeb(stream) : stream;
}

/**
 * Build a bounded media response after the caller has authorized filePath.
 * The stream is never buffered in memory; range requests are constrained to
 * the exact inclusive byte interval advertised in Content-Range.
 */
export function createRecordingMediaResponse(filePath, request = {}, fsImpl = fs) {
  const handle = openSafeRecordingFile(filePath, fsImpl);
  if (!handle) return new Response('Not found', { status: 404 });
  const stat = handle.stat;

  const range = parseByteRange(headerValue(request.headers, 'range'), stat.size);
  if (range.kind === 'invalid') {
    closeSafeRecordingFile(handle, fsImpl);
    return new Response(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${stat.size}`,
        'Content-Length': '0',
      },
    });
  }

  const partial = range.kind === 'range';
  const length = stat.size === 0 ? 0 : range.end - range.start + 1;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    'Content-Type': mediaContentType(filePath),
  };
  if (partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
  const method = String(request.method ?? 'GET').toUpperCase();
  if (method === 'HEAD' || length === 0) {
    closeSafeRecordingFile(handle, fsImpl);
    return new Response(null, { status: partial ? 206 : 200, headers });
  }
  if (!revalidateSafeRecordingFile(filePath, handle, fsImpl)) {
    closeSafeRecordingFile(handle, fsImpl);
    return new Response('Not found', { status: 404 });
  }
  let body;
  try {
    body = streamBody(fsImpl.createReadStream(null, { fd: handle.fd, start: range.start, end: range.end, autoClose: true, highWaterMark: MEDIA_STREAM_HIGH_WATER_MARK }));
  } catch {
    closeSafeRecordingFile(handle, fsImpl);
    return new Response('Not found', { status: 404 });
  }
  return new Response(body, { status: partial ? 206 : 200, headers });
}
