import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createIntelDriverDownloadService, parseIntelDownloadPage } from '../src/main/intel-driver-download.js';
import { INTEL_DRIVER_PAGES } from '../src/main/intel-driver-update.js';

const arcVersion = '32.0.101.9030';
const proVersion = '32.0.101.8805';
const exe = Buffer.from([0x4d, 0x5a, 1, 2, 3, 4]);
const digest = (algorithm = 'sha512', data = exe) => createHash(algorithm).update(data).digest('hex');
const mirrorFor = (version) => `https://downloadmirror.intel.com/123456/gfx_win_101.${version.split('.').at(-1)}.exe`;
const mirror = mirrorFor(arcVersion);
const releaseLookup = { resolveRelease: async (kind, version) => ({ version, officialPageUrl: INTEL_DRIVER_PAGES[kind].officialPageUrl }) };
function html(version, { kind = 'arc', data = exe, algorithm = kind === 'arc' ? 'sha512' : 'sha256', size = data.length, url = mirrorFor(version), versionText = version } = {}) {
  const digestLabel = algorithm.toUpperCase();
  return `<meta name="DownloadVersion" content="${versionText}">
    ${kind === 'pro' ? `<meta name="RecommendedDownloadUrl" content="${url}">` : ''}
    <a data-href="${url}">Download</a><div>Size: ${size} bytes</div><div>${digestLabel}: ${digest(algorithm, data)}</div>`;
}
function response({ body, url, headers = {}, status = 200 }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  return {
    ok: status >= 200 && status < 300, status, url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? (name.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    text: async () => bytes.toString('utf8'),
  };
}
async function fixture(fetchImpl, intelDriverUpdateService = releaseLookup) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arc-intel-download-'));
  const appDataPath = path.join(root, 'appdata');
  await fs.promises.mkdir(appDataPath);
  const service = createIntelDriverDownloadService({ appDataPath, appApi: { quit() {} }, fetchImpl, intelDriverUpdateService });
  const cleanup = () => fs.promises.rm(root, { recursive: true, force: true });
  return { root, appDataPath, service, cleanup };
}
function fixtureFetcher({ version = arcVersion, kind = 'arc', data = exe, algorithm, pageHtml, downloadHeaders = {}, responseUrl } = {}) {
  const page = pageHtml ?? html(version, { kind, data, algorithm });
  return async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url.includes('/download/')) return response({ body: page, url });
    if (url.startsWith('https://downloadmirror.intel.com/')) return response({ body: data, url: responseUrl ?? url, headers: downloadHeaders });
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('parses Arc SHA512 and Pro SHA256 metadata and rejects malformed versions, URLs, sizes, and digests', async () => {
  const proPage = html(proVersion, { kind: 'pro', algorithm: 'sha256', versionText: '32.0.101.8805 - Q2.26.R2' });
  let f = await fixture(fixtureFetcher({ version: proVersion, kind: 'pro', algorithm: 'sha256', pageHtml: proPage }));
  try { assert.deepEqual(await f.service.startDownload('pro', proVersion), { downloaded: true, sizeBytes: exe.length }); }
  finally { await f.cleanup(); }
  f = await fixture(fixtureFetcher());
  try { assert.deepEqual(await f.service.startDownload('arc', arcVersion), { downloaded: true, sizeBytes: exe.length }); }
  finally { await f.cleanup(); }
  for (const version of ['1.2.3', '1.2.3.4.5', '1.2.3.4-evil', '../1.2.3.4']) {
    await assert.rejects(() => f.service.startDownload('arc', version), /invalid Intel driver version/);
  }
  await assert.rejects(() => f.service.startDownload('other', arcVersion), /invalid kind/);
  for (const malformed of [
    html(arcVersion, { url: 'http://downloadmirror.intel.com/123456/gfx_win_101.9030.exe' }),
    html(arcVersion, { url: 'https://evil.example/123456/gfx_win_101.9030.exe' }),
    html(arcVersion, { url: 'https://downloadmirror.intel.com/123456/other.exe' }),
    html(arcVersion).replace('Size: 6 bytes', 'Size: unknown'),
    html(arcVersion).replace(digest(), 'not-a-digest'),
  ]) {
    const bad = await fixture(fixtureFetcher({ pageHtml: malformed }));
    try { await assert.rejects(() => bad.service.startDownload('arc', arcVersion)); }
    finally { await bad.cleanup(); }
  }
  const rounded = parseIntelDownloadPage(html(arcVersion).replace('Size: 6 bytes', 'Size: 889.1 MB'), 'arc');
  assert.equal(rounded.sizeBytes, Math.round(889.1 * 1024 ** 2));
  assert.ok(rounded.sizeToleranceBytes >= 52_000, 'the displayed one-decimal MB size is treated as rounded metadata');
});

test('downloads a historical release from its validated Intel archive page', async () => {
  const historicalUrl = 'https://www.intel.com/content/www/us/en/download/857252/123456/historical-intel-arc-graphics-drivers.html';
  const intelDriverUpdateService = {
    async resolveRelease(kind, version) {
      assert.equal(kind, 'arc');
      assert.equal(version, arcVersion);
      return { version, officialPageUrl: historicalUrl };
    },
  };
  const fetchImpl = async (url) => {
    if (url === historicalUrl) return response({ body: html(arcVersion), url });
    if (url.startsWith('https://downloadmirror.intel.com/')) return response({ body: exe, url });
    throw new Error(`unexpected URL: ${url}`);
  };
  const f = await fixture(fetchImpl, intelDriverUpdateService);
  try {
    assert.deepEqual(await f.service.startDownload('arc', arcVersion), { downloaded: true, sizeBytes: exe.length });
  } finally { await f.cleanup(); }
});

test('streams download progress, stores under appData, and enforces declared content length', async () => {
  const f = await fixture(fixtureFetcher());
  try {
    const progress = [];
    assert.deepEqual(await f.service.startDownload('arc', arcVersion, (item) => progress.push(item)), { downloaded: true, sizeBytes: exe.length });
    assert.deepEqual(progress, [
      { kind: 'arc', version: arcVersion, bytesDownloaded: exe.length, totalBytes: exe.length, percent: 99 },
      { kind: 'arc', version: arcVersion, bytesDownloaded: exe.length, totalBytes: exe.length, percent: 100 },
    ]);
    const target = path.join(f.appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion, 'gfx_win_101.exe');
    assert.deepEqual(await f.service.getStatus('arc', arcVersion), { downloaded: true, sizeBytes: exe.length });
    assert.deepEqual(await fs.promises.readFile(target), exe);
    assert.deepEqual(Object.keys(await f.service.getStatus('arc', arcVersion)).sort(), ['downloaded', 'sizeBytes']);
  } finally { await f.cleanup(); }
  const bad = await fixture(fixtureFetcher({ downloadHeaders: { 'content-length': '2000' } }));
  try { await assert.rejects(() => bad.service.startDownload('arc', arcVersion), /content length/); }
  finally { await bad.cleanup(); }
});

test('deletes only the exact downloaded installer and leaves its directory and other files', async () => {
  const f = await fixture(fixtureFetcher());
  const dir = path.join(f.appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion);
  const target = path.join(dir, 'gfx_win_101.exe');
  const other = path.join(dir, 'notes.txt');
  try {
    await f.service.startDownload('arc', arcVersion);
    await fs.promises.writeFile(other, 'keep this file');
    assert.deepEqual(await f.service.deleteDownloaded('arc', arcVersion), { deleted: true });
    assert.deepEqual(await f.service.deleteDownloaded('arc', arcVersion), { deleted: true }, 'deletion is idempotent');
    await assert.rejects(() => fs.promises.lstat(target), { code: 'ENOENT' });
    assert.equal(await fs.promises.readFile(other, 'utf8'), 'keep this file');
    assert.ok((await fs.promises.stat(dir)).isDirectory());
    assert.deepEqual(await f.service.getStatus('arc', arcVersion), { downloaded: false, sizeBytes: null });
    await assert.rejects(() => f.service.deleteDownloaded('other', arcVersion), /invalid kind/);
    await assert.rejects(() => f.service.deleteDownloaded('arc', '../other'), /invalid Intel driver version/);
  } finally { await f.cleanup(); }
});

test('refuses unsafe or non-regular installer targets and symlinked ancestors', async (t) => {
  const f = await fixture(fixtureFetcher());
  const dir = path.join(f.appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion);
  const target = path.join(dir, 'gfx_win_101.exe');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.mkdir(target);
    await assert.rejects(() => f.service.deleteDownloaded('arc', arcVersion), /regular file/);
    await fs.promises.rm(target, { recursive: true });
    const outside = path.join(f.root, 'outside.exe');
    await fs.promises.writeFile(outside, exe);
    let targetLinkCreated = true;
    try { await fs.promises.symlink(outside, target, 'file'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      targetLinkCreated = false;
    }
    if (targetLinkCreated) {
      await assert.rejects(() => f.service.deleteDownloaded('arc', arcVersion), /reparse|symbolic|unsafe/i);
      await fs.promises.unlink(target);
    }
    await fs.promises.rm(path.join(f.appDataPath, 'ArcPower'), { recursive: true });
    const outsideDir = path.join(f.root, 'outside-dir');
    await fs.promises.mkdir(outsideDir);
    try { await fs.promises.symlink(outsideDir, path.join(f.appDataPath, 'ArcPower'), 'junction'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip('junction creation is unavailable on this host');
      return;
    }
    await assert.rejects(() => f.service.deleteDownloaded('arc', arcVersion), /reparse|symbolic/i);
  } finally { await f.cleanup(); }
});

test('deletion cannot race active downloads or installs, and duplicate installs are rejected', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arc-intel-delete-race-'));
  const appDataPath = path.join(root, 'appdata'); await fs.promises.mkdir(appDataPath);
  let releasePage;
  let pageRequested;
  const requested = new Promise((resolve) => { pageRequested = resolve; });
  const pageGate = new Promise((resolve) => { releasePage = resolve; });
  const fetchImpl = async (url) => {
    if (url.includes('/download/')) {
      pageRequested();
      await pageGate;
      return response({ body: html(arcVersion), url });
    }
    return response({ body: exe, url });
  };
  const service = createIntelDriverDownloadService({ appDataPath, fetchImpl, appApi: { quit() {} }, intelDriverUpdateService: releaseLookup, spawnProcess() { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; } });
  try {
    const downloading = service.startDownload('arc', arcVersion);
    await requested;
    await assert.rejects(() => service.deleteDownloaded('arc', arcVersion), /active/);
    releasePage();
    await downloading;
    assert.deepEqual(await service.deleteDownloaded('arc', arcVersion), { deleted: true });
    const dir = path.join(appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion);
    await assert.rejects(() => fs.promises.stat(path.join(dir, 'gfx_win_101.exe')), { code: 'ENOENT' });
  } finally { releasePage(); await fs.promises.rm(root, { recursive: true, force: true }); }

  const f = await fixture(fixtureFetcher());
  let installPageRequested;
  let releaseInstallPage;
  const installRequested = new Promise((resolve) => { installPageRequested = resolve; });
  const installGate = new Promise((resolve) => { releaseInstallPage = resolve; });
  try {
    await f.service.startDownload('arc', arcVersion);
    const installService = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: async (url) => {
      if (url.includes('/download/')) { installPageRequested(); await installGate; }
      return url.includes('/download/') ? response({ body: html(arcVersion), url }) : response({ body: exe, url });
    }, appApi: { quit() {} }, intelDriverUpdateService: releaseLookup, spawnProcess() { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; } });
    const installing = installService.installDownloaded('arc', arcVersion);
    await installRequested;
    await assert.rejects(() => installService.deleteDownloaded('arc', arcVersion), /active/);
    await assert.rejects(() => installService.installDownloaded('arc', arcVersion), /already active/);
    releaseInstallPage();
    assert.deepEqual(await installing, { launched: true });
  } finally { releaseInstallPage?.(); await f.cleanup(); }
});

test('a crash-left partial is safely replaced by a fresh download', async () => {
  const f = await fixture(fixtureFetcher());
  const target = path.join(f.appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion, 'gfx_win_101.exe');
  const partial = `${target}.part`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(partial, Buffer.from('stale partial'));
    assert.deepEqual(await f.service.startDownload('arc', arcVersion), { downloaded: true, sizeBytes: exe.length });
    assert.equal((await fs.promises.readFile(target)).toString('hex'), exe.toString('hex'));
    await assert.rejects(() => fs.promises.stat(partial), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('cancellation aborts the active stream and removes its partial file', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arc-intel-cancel-'));
  const appDataPath = path.join(root, 'appdata'); await fs.promises.mkdir(appDataPath);
  const fetchImpl = async (url) => {
    if (url.includes('/download/')) return response({ body: html(arcVersion), url });
    return { ok: true, status: 200, url, headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(exe.length) : null }, body: new ReadableStream({ start(controller) { controller.enqueue(exe.subarray(0, 2)); } }) };
  };
  const service = createIntelDriverDownloadService({ appDataPath, fetchImpl, appApi: { quit() {} }, intelDriverUpdateService: releaseLookup });
  try {
    const pending = service.startDownload('arc', arcVersion);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await service.cancelDownload('arc'), { cancelled: true });
    await assert.rejects(pending);
    const dir = path.join(appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion);
    assert.deepEqual((await fs.promises.readdir(dir)).filter((name) => name.endsWith('.part')), []);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('checksum failure prevents install and removes partial download', async () => {
  const f = await fixture(fixtureFetcher());
  let launched = false;
  try {
    await f.service.startDownload('arc', arcVersion);
    const badDataFetcher = async (url, options) => {
      const result = fixtureFetcher({ data: exe });
      if (url.includes('/download/')) return response({ body: html(arcVersion).replace(digest(), '0'.repeat(128)), url });
      return result(url, options);
    };
    const svc = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: badDataFetcher, appApi: { quit() {} }, intelDriverUpdateService: releaseLookup, spawnProcess: () => { launched = true; throw new Error('must not launch'); } });
    await assert.rejects(() => svc.installDownloaded('arc', arcVersion), /could not be verified/);
    assert.equal(launched, false);
    assert.deepEqual(await svc.getStatus('arc', arcVersion), { downloaded: false, sizeBytes: null }, 'an invalid retained installer is removed so the UI can offer a fresh download');
    const fresh = await fixture(badDataFetcher);
    try {
      await assert.rejects(() => fresh.service.startDownload('arc', arcVersion), /checksum/);
      const freshDir = path.join(fresh.appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion);
      assert.deepEqual((await fs.promises.readdir(freshDir)).filter((name) => name.endsWith('.part')), []);
    } finally { await fresh.cleanup(); }
    const dir = path.join(f.appDataPath, 'ArcPower', 'DriverDownloads', 'arc', arcVersion);
    assert.deepEqual((await fs.promises.readdir(dir)).filter((name) => name.endsWith('.part')), []);
  } finally { await f.cleanup(); }
});

test('installation guards against a stale release and quits only after confirmed spawn', async () => {
  const f = await fixture(fixtureFetcher());
  try {
    await f.service.startDownload('arc', arcVersion);
    let quits = 0; let calls = 0;
    const stale = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: fixtureFetcher({ version: '32.0.101.9999' }), appApi: { quit() { quits++; } }, intelDriverUpdateService: releaseLookup, spawnProcess() { calls++; } });
    await assert.rejects(() => stale.installDownloaded('arc', arcVersion), /no longer matches/);
    assert.equal(calls, 0); assert.equal(quits, 0);
    const current = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: fixtureFetcher(), appApi: { quit() { quits++; } }, intelDriverUpdateService: releaseLookup, spawnProcess(executable, args, options) {
      assert.match(executable, /gfx_win_101\.exe$/); assert.deepEqual(args, []); assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
      const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
    } });
    assert.deepEqual(await current.installDownloaded('arc', arcVersion), { launched: true });
    assert.equal(quits, 1);
  } finally { await f.cleanup(); }
});

test('rejects a symlinked download ancestor and never launches through it', async (t) => {
  const f = await fixture(fixtureFetcher());
  const link = path.join(f.appDataPath, 'ArcPower');
  const outside = path.join(f.root, 'outside'); await fs.promises.mkdir(outside);
  try { await fs.promises.symlink(outside, link, 'junction'); }
  catch (error) { await f.cleanup(); if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('junction creation is unavailable'); throw error; }
  let launches = 0;
  const service = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: fixtureFetcher(), appApi: { quit() {} }, intelDriverUpdateService: releaseLookup, spawnProcess() { launches++; } });
  try {
    await assert.rejects(() => service.startDownload('arc', arcVersion), /reparse|symbolic/i);
    await assert.rejects(() => service.installDownloaded('arc', arcVersion), /reparse|symbolic/i);
    assert.equal(launches, 0);
  } finally { await f.cleanup(); }
});
