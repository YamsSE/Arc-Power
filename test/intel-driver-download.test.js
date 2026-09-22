import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createIntelDriverDownloadService, parseIntelDownloadPage } from '../src/main/intel-driver-download.js';

const arcVersion = '32.0.101.9030';
const proVersion = '32.0.101.8805';
const exe = Buffer.from([0x4d, 0x5a, 1, 2, 3, 4]);
const digest = (algorithm = 'sha512', data = exe) => createHash(algorithm).update(data).digest('hex');
const mirrorFor = (version) => `https://downloadmirror.intel.com/123456/gfx_win_101.${version.split('.').at(-1)}.exe`;
const mirror = mirrorFor(arcVersion);
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
async function fixture(fetchImpl) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arc-intel-download-'));
  const appDataPath = path.join(root, 'appdata');
  await fs.promises.mkdir(appDataPath);
  const service = createIntelDriverDownloadService({ appDataPath, appApi: { quit() {} }, fetchImpl });
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
  const service = createIntelDriverDownloadService({ appDataPath, fetchImpl, appApi: { quit() {} } });
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
    const svc = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: badDataFetcher, appApi: { quit() {} }, spawnProcess: () => { launched = true; throw new Error('must not launch'); } });
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
    const stale = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: fixtureFetcher({ version: '32.0.101.9999' }), appApi: { quit() { quits++; } }, spawnProcess() { calls++; } });
    await assert.rejects(() => stale.installDownloaded('arc', arcVersion), /no longer matches/);
    assert.equal(calls, 0); assert.equal(quits, 0);
    const current = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: fixtureFetcher(), appApi: { quit() { quits++; } }, spawnProcess(executable, args, options) {
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
  const service = createIntelDriverDownloadService({ appDataPath: f.appDataPath, fetchImpl: fixtureFetcher(), appApi: { quit() {} }, spawnProcess() { launches++; } });
  try {
    await assert.rejects(() => service.startDownload('arc', arcVersion), /reparse|symbolic/i);
    await assert.rejects(() => service.installDownloaded('arc', arcVersion), /reparse|symbolic/i);
    assert.equal(launches, 0);
  } finally { await f.cleanup(); }
});
