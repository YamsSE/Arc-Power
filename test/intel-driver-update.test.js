import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIntelDriverMetadata, createIntelDriverUpdateService, INTEL_DRIVER_PAGES } from '../src/main/intel-driver-update.js';

const page = (version, releaseDate = '') => `<main>Intel Graphics Driver ${version}. ${releaseDate}</main>`;
const response = (text, url) => ({
  ok: true,
  url,
  headers: { get: () => String(Buffer.byteLength(text)) },
  body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
});

test('Intel metadata parser accepts only a four-part driver version and normalizes an optional date', () => {
  assert.deepEqual(parseIntelDriverMetadata('<p>Intel® Graphics Driver 32.0.101.9030</p><p>Release Date: September 2, 2026</p>'), {
    version: '32.0.101.9030', releaseDate: '2026-09-02',
  });
  for (const value of ['32.0.101', '32.0.101.9030.1', '1.2.3.4', 'Driver 32.0.101.9030']) {
    assert.equal(parseIntelDriverMetadata(value), null, value);
  }
  assert.deepEqual(parseIntelDriverMetadata('Intel Graphics Driver 1.2.3.4 Release Date: 2026-02-30'), {
    version: '1.2.3.4', releaseDate: null,
  });
});

test('Intel metadata parser prefers Intel DownloadVersion and lastModifieddate meta attributes', () => {
  const fixture = `<!doctype html><html><head>
    <meta name="DownloadVersion" content="32.0.101.8805-PRO">
    <meta name="lastModifieddate" content="2026-09-02T00:00:00Z">
  </head><body><p>Intel Graphics Driver 32.0.101.9030</p></body></html>`;
  assert.deepEqual(parseIntelDriverMetadata(fixture), { version: '32.0.101.8805', releaseDate: '2026-09-02' });
  assert.deepEqual(parseIntelDriverMetadata('<meta name="DownloadVersion" content="32.0.101.9030"><meta name="lastModifieddate" content="09/02/2026 00:00:00">'), {
    version: '32.0.101.9030', releaseDate: '2026-09-02',
  });
  assert.equal(parseIntelDriverMetadata('<meta name="DownloadVersion" content="32.0.101.8805.1">'), null,
    'a fifth numeric component is not accepted as a suffix');
});

test('Intel metadata service fetches fixed HTTPS pages, caches success, and serves stale success after failure', async () => {
  let now = 100;
  let fail = false;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (fail) throw new Error('offline');
    const kind = url.includes('/741626/') ? 'pro' : 'arc';
    return response(page(kind === 'pro' ? '32.0.101.8805' : '32.0.101.9030'), url);
  };
  const service = createIntelDriverUpdateService({ fetchImpl, now: () => now, cacheTtlMs: 10 });
  const first = await service.check();
  assert.equal(first.arc.version, '32.0.101.9030');
  assert.equal(first.pro.version, '32.0.101.8805');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.redirect === 'error' && options.signal instanceof AbortSignal));
  await service.check();
  assert.equal(calls.length, 2, 'fresh values are cached');
  now = 111;
  fail = true;
  assert.deepEqual(await service.check(), first, 'an outage falls back to the last successful metadata');
});

test('Intel metadata service rejects a redirect outside the exact Intel page and bounds response size', async () => {
  const wrongUrl = 'https://www.intel.com/evil';
  const redirected = createIntelDriverUpdateService({ fetchImpl: async () => response(page('32.0.101.9030'), wrongUrl) });
  assert.deepEqual(await redirected.check(), { arc: null, pro: null });
  const queryUrl = 'https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html?redirect=1';
  const queried = createIntelDriverUpdateService({ fetchImpl: async () => response(page('32.0.101.9030'), queryUrl) });
  assert.deepEqual(await queried.check(), { arc: null, pro: null });
  const oversized = createIntelDriverUpdateService({
    maxResponseBytes: 8,
    fetchImpl: async (url) => response(page('32.0.101.9030'), url),
  });
  assert.deepEqual(await oversized.check(), { arc: null, pro: null });
});

test('Intel metadata service aborts a request when its finite timeout elapses', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const service = createIntelDriverUpdateService({ fetchImpl, timeoutMs: 5 });
  assert.deepEqual(await service.check(), { arc: null, pro: null });
});

test('download page choices are fixed official Intel URLs', () => {
  assert.deepEqual(Object.keys(INTEL_DRIVER_PAGES), ['arc', 'pro']);
  for (const pageInfo of Object.values(INTEL_DRIVER_PAGES)) {
    const url = new URL(pageInfo.officialPageUrl);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'www.intel.com');
    assert.match(url.pathname, /^\/content\/www\/us\/en\/download\/(785597|741626)\//);
  }
});

test('preload exposes the narrow window.arcPower API without a URL argument', () => {
  const preload = fs.readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /intelDriverUpdateCheck:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-update-check'\)/);
  assert.match(preload, /openIntelDriverDownloadPage:\s*\(kind\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-download-page-open',\s*kind\)/);
  assert.doesNotMatch(preload, /openIntelDriverDownloadPage:\s*\(url\)/);
});
