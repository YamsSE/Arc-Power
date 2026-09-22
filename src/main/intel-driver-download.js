import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { INTEL_DRIVER_PAGES } from './intel-driver-update.js';
import { openSafeRecordingFile, revalidateSafeRecordingFile } from './recording-media.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const PAGE_TIMEOUT_MS = 20 * 1000;
const VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const INSTALLER_RE = /^gfx_win_101\.(\d+)\.exe$/i;
const allowedMirrorUrl = (value) => safeUrl(value, ['downloadmirror.intel.com'])
  && /^\/\d+\/gfx_win_101\.\d+\.exe$/i.test(new URL(value).pathname);

const validKind = (kind) => kind === 'arc' || kind === 'pro';
const safeUrl = (value, hosts) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname.toLowerCase())
      && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
};
function meta(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = source.match(new RegExp(`<meta\\b(?=[^>]*\\bname\\s*=\\s*["']${escaped}["'])[^>]*>`, 'i'))?.[0];
  return tag?.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2] ?? null;
}
export function parseIntelDownloadPage(source, kind) {
  if (!validKind(kind)) throw new Error('invalid kind');
  const versionText = meta(source, 'DownloadVersion')?.trim() ?? '';
  const versionMatch = versionText.match(/^(\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5})(?:\s+-\s+Q\d{1,2}\.\d{2}\.R\d+)?$/i);
  const version = versionMatch?.[1] ?? null;
  if (!VERSION_RE.test(version ?? '')) throw new Error('Intel release page has an invalid driver version');
  const hrefs = [];
  for (const match of source.matchAll(/\b(?:data-href|href)\s*=\s*(["'])(.*?)\1/gi)) hrefs.push(match[2].replaceAll('&amp;', '&'));
  if (kind === 'pro') {
    const recommended = meta(source, 'RecommendedDownloadUrl');
    if (recommended) hrefs.unshift(recommended.replaceAll('&amp;', '&'));
  }
  const url = hrefs.map((href) => { try { return new URL(href, INTEL_DRIVER_PAGES[kind].officialPageUrl).href; } catch { return ''; } })
    .find((href) => allowedMirrorUrl(href));
  if (!url) throw new Error('Intel release page has no valid installer link');
  if (path.posix.basename(new URL(url).pathname).match(INSTALLER_RE)?.[1] !== version.split('.').at(-1)) throw new Error('Intel installer link version does not match the page version');
  const sizeMatch = source.match(/\bSize\b\s*:?\s*(?:<[^>]*>\s*)*(\d+(?:\.\d+)?)\s*(GB|MB|KB|bytes?)\b/i);
  if (!sizeMatch) throw new Error('Intel release page has no valid installer size');
  const unit = sizeMatch[2].toLowerCase();
  const multiplier = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1;
  const sizeBytes = Math.round(Number(sizeMatch[1]) * multiplier);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) throw new Error('Intel installer size is outside the allowed limit');
  const decimalPlaces = sizeMatch[1].split('.')[1]?.length ?? 0;
  const sizeToleranceBytes = Math.max(1024, Math.ceil(multiplier * 0.5 * (10 ** -decimalPlaces)));
  const sha = source.match(/\bSHA\s*[- ]?(256|512)\b\s*:?\s*(?:<[^>]*>\s*)*([a-f\d]{128}|[a-f\d]{64})/i);
  if (!sha) throw new Error('Intel release page has no valid SHA256 or SHA512 digest');
  const algorithm = sha[1] === '512' ? 'sha512' : 'sha256';
  if (sha[2].length !== (algorithm === 'sha512' ? 128 : 64)) throw new Error('Intel digest length is invalid');
  return { version, url, sizeBytes, sizeToleranceBytes, algorithm, digest: sha[2].toLowerCase() };
}

export function createIntelDriverDownloadService({ appDataPath, appApi, fetchImpl = globalThis.fetch, spawnProcess = spawn, fsImpl = fs }) {
  if (typeof appDataPath !== 'string' || !path.isAbsolute(appDataPath)) throw new TypeError('appDataPath must be absolute');
  if (typeof appApi?.quit !== 'function') throw new TypeError('appApi.quit is required');
  if (typeof fetchImpl !== 'function' || typeof spawnProcess !== 'function') throw new TypeError('fetchImpl and spawnProcess are required');
  const transfers = new Map();
  const basePath = path.join(appDataPath, 'ArcPower', 'DriverDownloads');
  const filePath = (kind, version) => path.join(basePath, kind, version, `gfx_win_101.exe`);
  function validate(kind, version) {
    if (!validKind(kind)) throw new Error('invalid kind');
    if (!VERSION_RE.test(version ?? '')) throw new Error('invalid Intel driver version');
  }
  async function assertSafePath(target, allowMissing = true) {
    const parsed = path.parse(path.resolve(target));
    let current = parsed.root;
    for (const segment of path.resolve(target).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = await fsImpl.promises.lstat(current);
        if (stat.isSymbolicLink() || (typeof stat.isReparsePoint === 'function' && stat.isReparsePoint())) throw new Error('unsafe reparse path');
      } catch (error) {
        if (error.code === 'ENOENT' && allowMissing) continue;
        throw error;
      }
    }
  }
  async function fetchWithRedirects(initialUrl, signal, hosts) {
    let url = initialUrl;
    for (let i = 0; i <= 5; i++) {
      if (!(hosts.includes('downloadmirror.intel.com') ? allowedMirrorUrl(url) : safeUrl(url, hosts))) throw new Error('Intel download URL is not allowed');
      const response = await fetchImpl(url, { signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        if (!location || i === 5) throw new Error('too many or invalid Intel redirects');
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) throw new Error(`Intel request failed (${response.status})`);
      if (response.url && !(hosts.includes('downloadmirror.intel.com')
        ? allowedMirrorUrl(response.url)
        : safeUrl(response.url, hosts))) throw new Error('Intel redirected outside the allowlist');
      return response;
    }
    throw new Error('too many Intel redirects');
  }
  async function fetchPage(kind, signal) {
    const pageController = new AbortController();
    const timer = setTimeout(() => pageController.abort(new Error('Intel release page request timed out')), PAGE_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, pageController.signal]) : pageController.signal;
    try {
      const response = await fetchWithRedirects(INTEL_DRIVER_PAGES[kind].officialPageUrl, combinedSignal, ['www.intel.com']);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error('Intel release page is too large');
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error('Intel release page is too large'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock?.(); }
        text = Buffer.concat(chunks, length).toString('utf8');
      } else {
        text = await response.text();
        if (Buffer.byteLength(text) > MAX_PAGE_BYTES) throw new Error('Intel release page is too large');
      }
      if (response.url && new URL(response.url).href !== INTEL_DRIVER_PAGES[kind].officialPageUrl) throw new Error('Intel release page URL changed');
      return parseIntelDownloadPage(text, kind);
    } finally { clearTimeout(timer); }
  }
  async function hashFile(target, algorithm) {
    const safe = openSafeRecordingFile(target, fsImpl);
    if (!safe) throw new Error('Intel installer path is unsafe');
    const hash = createHash(algorithm);
    try {
      const stream = fsImpl.createReadStream(target, { fd: safe.fd, autoClose: false });
      for await (const chunk of stream) hash.update(chunk);
      if (!revalidateSafeRecordingFile(target, safe, fsImpl)) throw new Error('Intel installer path changed during verification');
      return hash.digest('hex');
    } finally { try { fsImpl.closeSync(safe.fd); } catch { /* best effort */ } }
  }
  async function verify(target, metadata) {
    await assertSafePath(target, false);
    const stat = await fsImpl.promises.stat(target);
    if (!stat.isFile() || Math.abs(stat.size - metadata.sizeBytes) > metadata.sizeToleranceBytes || stat.size > MAX_FILE_BYTES) throw new Error('saved Intel installer size does not match the release page');
    if (await hashFile(target, metadata.algorithm) !== metadata.digest) throw new Error('saved Intel installer checksum does not match Intel');
    const safe = openSafeRecordingFile(target, fsImpl);
    if (!safe) throw new Error('Intel installer path is unsafe');
    try {
      const header = Buffer.alloc(2);
      const bytesRead = fsImpl.readSync(safe.fd, header, 0, 2, 0);
      if (bytesRead !== 2 || header.toString('ascii') !== 'MZ') throw new Error('download is not a Windows executable');
      if (!revalidateSafeRecordingFile(target, safe, fsImpl)) throw new Error('Intel installer path changed during verification');
    } finally { try { fsImpl.closeSync(safe.fd); } catch { /* best effort */ } }
  }
  async function getStatus(kind, version) {
    validate(kind, version);
    const target = filePath(kind, version);
    try {
      await assertSafePath(target, false);
      const stat = await fsImpl.promises.stat(target);
      return { downloaded: stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES, sizeBytes: stat.isFile() ? stat.size : null };
    } catch { return { downloaded: false, sizeBytes: null }; }
  }
  async function startDownload(kind, version, onProgress = () => {}) {
    validate(kind, version);
    if (transfers.has(kind)) throw new Error('a download is already active for this driver kind');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Intel download timed out')), TRANSFER_TIMEOUT_MS);
    const transfer = { controller };
    transfers.set(kind, transfer);
    const target = filePath(kind, version);
    const partial = `${target}.part`;
    try {
      await assertSafePath(target);
      const metadata = await fetchPage(kind, controller.signal);
      if (metadata.version !== version) throw new Error('Intel release version no longer matches expected version');
      if (await getStatus(kind, version).then((s) => s.downloaded)) {
        try {
          await verify(target, metadata);
          return { downloaded: true, sizeBytes: (await fsImpl.promises.stat(target)).size };
        } catch {
          await assertSafePath(target, false);
          const existing = await fsImpl.promises.lstat(target);
          if (!existing.isFile()) throw new Error('existing Intel driver download is not a regular file');
          await fsImpl.promises.unlink(target);
        }
      }
      await fsImpl.promises.mkdir(path.dirname(target), { recursive: true });
      await assertSafePath(partial);
      try {
        const stalePart = await fsImpl.promises.lstat(partial);
        if (!stalePart.isFile()) throw new Error('existing partial Intel download is not a regular file');
        await fsImpl.promises.unlink(partial);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const response = await fetchWithRedirects(metadata.url, controller.signal, ['downloadmirror.intel.com']);
      const contentLengthHeader = response.headers?.get?.('content-length');
      const length = contentLengthHeader === null || contentLengthHeader === undefined || contentLengthHeader === ''
        ? null
        : Number(contentLengthHeader);
      if (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > MAX_FILE_BYTES
        || Math.abs(length - metadata.sizeBytes) > metadata.sizeToleranceBytes)) {
        throw new Error('download content length does not match Intel page size');
      }
      const expectedBytes = length ?? metadata.sizeBytes;
      if (!response.body) throw new Error('Intel download has no response body');
      let bytesDownloaded = 0;
      const hash = createHash(metadata.algorithm);
      const reader = response.body.getReader ? response.body.getReader() : Readable.toWeb(response.body).getReader();
      const onAbort = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const readable = Readable.from((async function* () {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) throw controller.signal.reason ?? new Error('Intel download cancelled');
            bytesDownloaded += value.byteLength;
            if (bytesDownloaded > metadata.sizeBytes + metadata.sizeToleranceBytes || (length !== null && bytesDownloaded > length) || bytesDownloaded > MAX_FILE_BYTES) throw new Error('Intel download exceeded declared size');
            const chunk = Buffer.from(value);
            hash.update(chunk);
            const percent = Math.min(99, Math.floor(bytesDownloaded * 100 / expectedBytes));
            onProgress({ kind, version, bytesDownloaded, totalBytes: expectedBytes, percent });
            yield chunk;
          }
        } finally { controller.signal.removeEventListener('abort', onAbort); }
      })());
      await pipeline(readable, fsImpl.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if ((length !== null && bytesDownloaded !== length)
        || Math.abs(bytesDownloaded - metadata.sizeBytes) > metadata.sizeToleranceBytes) {
        throw new Error('Intel download size does not match release page');
      }
      if (hash.digest('hex') !== metadata.digest) throw new Error('Intel installer checksum does not match Intel');
      const safe = openSafeRecordingFile(partial, fsImpl);
      if (!safe) throw new Error('Intel installer path is unsafe');
      try {
        const header = Buffer.alloc(2);
        const bytesRead = fsImpl.readSync(safe.fd, header, 0, 2, 0);
        if (bytesRead !== 2 || header.toString('ascii') !== 'MZ') throw new Error('download is not a Windows executable');
        if (!revalidateSafeRecordingFile(partial, safe, fsImpl)) throw new Error('Intel installer path changed during verification');
      } finally { try { fsImpl.closeSync(safe.fd); } catch { /* best effort */ } }
      await assertSafePath(partial, false);
      await fsImpl.promises.rename(partial, target);
      onProgress({ kind, version, bytesDownloaded, totalBytes: expectedBytes, percent: 100 });
      return { downloaded: true, sizeBytes: bytesDownloaded };
    } catch (error) {
      try { await fsImpl.promises.unlink(partial); } catch { /* absent */ }
      throw error;
    } finally { clearTimeout(timeout); if (transfers.get(kind) === transfer) transfers.delete(kind); }
  }
  async function cancelDownload(kind) {
    if (!validKind(kind)) throw new Error('invalid kind');
    const transfer = transfers.get(kind);
    if (!transfer) return { cancelled: false };
    transfer.controller.abort(new Error('Intel download cancelled'));
    return { cancelled: true };
  }
  async function installDownloaded(kind, version) {
    validate(kind, version);
    const target = filePath(kind, version);
    await assertSafePath(target, false);
    const controller = new AbortController();
    const metadata = await fetchPage(kind, controller.signal);
    if (metadata.version !== version) throw new Error('Intel release version no longer matches expected version');
    try {
      await verify(target, metadata);
    } catch (error) {
      if (!/unsafe path|path changed/i.test(error?.message ?? '')) {
        try {
          await assertSafePath(target, false);
          const existing = await fsImpl.promises.lstat(target);
          if (existing.isFile()) await fsImpl.promises.unlink(target);
        } catch { /* leave unverifiable paths untouched */ }
      }
      throw new Error('Saved Intel driver could not be verified. Download it again.');
    }
    await assertSafePath(target, false);
    const child = spawnProcess(target, [], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => {
      const onError = (error) => { child.removeListener?.('spawn', onSpawn); reject(error); };
      const onSpawn = () => { child.removeListener?.('error', onError); resolve(); };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
    child.unref?.();
    appApi?.quit?.();
    return { launched: true };
  }
  return { getStatus, startDownload, cancelDownload, installDownloaded };
}
