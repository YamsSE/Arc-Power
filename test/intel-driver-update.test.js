import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIntelDriverMetadata, createIntelDriverUpdateService, INTEL_DRIVER_PAGES, validIntelDriverReleaseUrl } from '../src/main/intel-driver-update.js';

const page = (version, releaseDate = '') => `<main>Intel Graphics Driver ${version}. ${releaseDate}</main>`;
const response = (text, url) => ({
  ok: true,
  url,
  headers: { get: () => String(Buffer.byteLength(text)) },
  body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
});

test('Intel metadata parser accepts only a four-part driver version and normalizes an optional date', () => {
  assert.deepEqual(parseIntelDriverMetadata('<p>Intel® Graphics Driver 32.0.101.9030</p><p>Release Date: September 2, 2026</p>'), {
    version: '32.0.101.9030', releaseDate: '2026-09-02', changelog: [],
  });
  for (const value of ['32.0.101', '32.0.101.9030.1', '1.2.3.4', 'Driver 32.0.101.9030']) {
    assert.equal(parseIntelDriverMetadata(value), null, value);
  }
  assert.deepEqual(parseIntelDriverMetadata('Intel Graphics Driver 1.2.3.4 Release Date: 2026-02-30'), {
    version: '1.2.3.4', releaseDate: null, changelog: [],
  });
});

test('Intel metadata parser prefers Intel DownloadVersion and lastModifieddate meta attributes', () => {
  const fixture = `<!doctype html><html><head>
    <meta name="DownloadVersion" content="32.0.101.8805-PRO">
    <meta name="lastModifieddate" content="2026-09-02T00:00:00Z">
  </head><body><p>Intel Graphics Driver 32.0.101.9030</p></body></html>`;
  assert.deepEqual(parseIntelDriverMetadata(fixture), { version: '32.0.101.8805', releaseDate: '2026-09-02', changelog: [] });
  assert.deepEqual(parseIntelDriverMetadata('<meta name="DownloadVersion" content="32.0.101.9030"><meta name="lastModifieddate" content="09/02/2026 00:00:00">'), {
    version: '32.0.101.9030', releaseDate: '2026-09-02', changelog: [],
  });
  assert.equal(parseIntelDriverMetadata('<meta name="DownloadVersion" content="32.0.101.8805.1">'), null,
    'a fifth numeric component is not accepted as a suffix');
});

test('Intel metadata extracts bounded text highlights from Arc and Pro sections', () => {
  const arc = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul>
    <li>Improved stability &amp; performance<ul><li>Updated game profile</li></ul></li>
    <li>Fixed <strong>display</strong> flicker</li>
  </ul><h2>Specifications</h2><ul><li>Not a highlight</li></ul>`);
  assert.deepEqual(arc.changelog, ['Improved stability & performance', 'Updated game profile', 'Fixed display flicker']);

  const pro = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.8805<h2>Detailed Description</h2><h3>Highlights of this Workstation Driver:</h3><ul><li>Certified application updates</li></ul>`);
  assert.deepEqual(pro.changelog, ['Certified application updates']);

  assert.deepEqual(parseIntelDriverMetadata('Intel Graphics Driver 32.0.101.9030<h2>Overview</h2><ul><li>Ordinary page content</li></ul>').changelog, []);
});

test('Intel metadata includes the main Highlights introduction and stops before support and product sections', () => {
  const arc = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030
    <h2>Detailed Description</h2>
    <p><strong>Highlights:</strong></p>
    <p>Intel Game On Driver support for the latest titles, including:</p>
    <ul><li>WARDOGS*</li><li>Nested parent<ul><li>Nested child</li></ul></li></ul>
    <p><strong>OS Support:</strong></p><ul><li>Windows 11</li></ul>
    <p>Products:</p><ul><li>Intel Arc Graphics</li></ul>`);
  assert.deepEqual(arc.changelog, [
    'Intel Game On Driver support for the latest titles, including:',
    'WARDOGS*', 'Nested parent', 'Nested child',
  ]);

  const pro = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.8805
    <h2>Detailed Description</h2>
    <p><b>Highlights of this Workstation Driver:</b></p>
    <p>New features and fixes for professional applications.</p>
    <ul><li>Application certification updates</li></ul>
    <p>Platform Support</p><ul><li>Windows</li></ul>`);
  assert.deepEqual(pro.changelog, [
    'New features and fixes for professional applications.',
    'Application certification updates',
  ]);

  const plain = parseIntelDriverMetadata('Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2> Highlights: Game On support for: <ul><li>WARDOGS*</li></ul><h3>Notes</h3>Additional details');
  assert.deepEqual(plain.changelog, ['Game On support for:', 'WARDOGS*']);
});

test('Intel release highlights preserve GPU sections, game groups, and nested improvements', () => {
  const release = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030
    <h2>Detailed Description</h2><h2>Highlights:</h2><ul>
      <li>Intel® Game On driver support on Intel® Arc™ B-series Graphics GPUs for:
        <ul><li>1666: Amsterdam*</li></ul>
      </li>
      <li>Game performance improvements on Intel® Core™ Ultra Series 3 with built-in Intel® Arc™ GPUs for:
        <ul>
          <li>Assassin’s Creed Valhalla* (DX12)<ul><li>Up to 7% average FPS uplift at 1080p with Medium settings</li><li>Up to 11% average FPS uplift at 1080p with High settings</li></ul></li>
          <li>Farming Simulator 2022* (DX12)<ul><li>Up to 13% average FPS uplift at 1080p with Medium settings</li></ul></li>
        </ul>
      </li>
    </ul>`);

  assert.deepEqual(release.changelog, [
    'Intel® Game On driver support on Intel® Arc™ B-series Graphics GPUs for:',
    '1666: Amsterdam*',
    'Game performance improvements on Intel® Core™ Ultra Series 3 with built-in Intel® Arc™ GPUs for:',
    'Assassin’s Creed Valhalla* (DX12)',
    'Up to 7% average FPS uplift at 1080p with Medium settings',
    'Up to 11% average FPS uplift at 1080p with High settings',
    'Farming Simulator 2022* (DX12)',
    'Up to 13% average FPS uplift at 1080p with Medium settings',
  ]);
  assert.deepEqual(release.changelogSections, [
    { text: 'Intel® Game On driver support on Intel® Arc™ B-series Graphics GPUs for:', kind: 'heading', children: [
      { text: '1666: Amsterdam*', kind: 'item' },
    ] },
    { text: 'Game performance improvements on Intel® Core™ Ultra Series 3 with built-in Intel® Arc™ GPUs for:', kind: 'heading', children: [
      { text: 'Assassin’s Creed Valhalla* (DX12)', kind: 'item', children: [
        { text: 'Up to 7% average FPS uplift at 1080p with Medium settings', kind: 'item' },
        { text: 'Up to 11% average FPS uplift at 1080p with High settings', kind: 'item' },
      ] },
      { text: 'Farming Simulator 2022* (DX12)', kind: 'item', children: [
        { text: 'Up to 13% average FPS uplift at 1080p with Medium settings', kind: 'item' },
      ] },
    ] },
  ]);
});

test('Intel Arc Pro workstation highlights use the same GPU and game grouping', () => {
  const release = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.8805
    <h2>Detailed Description</h2><h3>Highlights of this Workstation Driver:</h3>
    <ul>
      <li>Game performance improvements on Intel® Arc™ Pro GPUs for:
        <ul><li>Autodesk Maya*<ul><li>Improved viewport rendering performance</li></ul></li></ul>
      </li>
      <li>Added GPU-specific support for:
        <ul><li>Certified workstation applications*</li></ul>
      </li>
    </ul>`);

  assert.deepEqual(release.changelogSections, [
    { text: 'Game performance improvements on Intel® Arc™ Pro GPUs for:', kind: 'heading', children: [
      { text: 'Autodesk Maya*', kind: 'item', children: [
        { text: 'Improved viewport rendering performance', kind: 'item' },
      ] },
    ] },
    { text: 'Added GPU-specific support for:', kind: 'heading', children: [
      { text: 'Certified workstation applications*', kind: 'item' },
    ] },
  ]);
});

test('Intel metadata scopes Highlights to Detailed Description and ignores comment/script decoys', () => {
  const parsed = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030
    <!-- <h2>Detailed Description</h2><p>Highlights: comment decoy</p><ul><li>Comment item</li></ul> -->
    <script>var page = '<h2>Detailed Description</h2><p>Highlights: script decoy</p>';</script>
    <h2>Detailed Description</h2><p><strong>Highlights:</strong></p>
    <p>Actual driver highlights.</p><ul><li>Actual item</li></ul><h2>Other section</h2>
    <p>Highlights: unrelated later content</p><ul><li>Must not leak</li></ul>`);
  assert.deepEqual(parsed.changelog, ['Actual driver highlights.', 'Actual item']);

  const missing = parseIntelDriverMetadata('Intel Graphics Driver 32.0.101.9030<p>Highlights: outside the required section</p><ul><li>Must not leak</li></ul>');
  assert.deepEqual(missing.changelog, []);
});

test('Intel Pro highlights stop before OS Reference and Platform (OS Support)', () => {
  const osReference = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.8805
    <h2>Detailed Description</h2><p><strong>Highlights of this Workstation Driver:</strong></p>
    <p>Pro driver improvements.</p><ul><li>Certified applications</li></ul>
    <p><strong>OS Reference:</strong></p><ul><li>Windows 11</li></ul>`);
  assert.deepEqual(osReference.changelog, ['Pro driver improvements.', 'Certified applications']);

  const platformSupport = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.8805
    <h2>Detailed Description</h2><p><strong>Highlights of this Workstation Driver:</strong></p>
    <ul><li>Pro feature</li></ul><p>Platform (OS Support)</p><ul><li>Windows Server</li></ul>`);
  assert.deepEqual(platformSupport.changelog, ['Pro feature']);
});

test('Intel metadata decodes named and numeric trademark entities in highlights', () => {
  const parsed = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030
    <h2>Detailed Description</h2>
    <p><strong>Highlights:</strong></p>
    <p>Intel&reg; Game On&trade; support &#174; &#x2122; &amp;reg;</p>`);
  assert.deepEqual(parsed.changelog, ['Intel® Game On™ support ® ™ &reg;']);
});

test('Intel metadata rejects malformed and oversized highlight lists', () => {
  const malformed = parseIntelDriverMetadata('Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul><li>Missing closing item</ul>');
  assert.deepEqual(malformed.changelog, []);
  const oversized = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul><li>${'x'.repeat(501)}</li></ul>`);
  assert.deepEqual(oversized.changelog, []);
  const tooMany = parseIntelDriverMetadata(`Intel Graphics Driver 32.0.101.9030<h2>Detailed Description</h2><h2>Highlights:</h2><ul>${'<li>Item</li>'.repeat(21)}</ul>`);
  assert.deepEqual(tooMany.changelog, []);
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

test('Intel driver library merges current and historical releases and resolves an archived version', async () => {
  const current = INTEL_DRIVER_PAGES.arc.officialPageUrl;
  const historical = INTEL_DRIVER_PAGES.arc.historicalPageUrl;
  const current9000 = '32.0.101.9000';
  const overlap = '32.0.101.8826';
  const archived = '32.0.101.7000';
  const detailUrl = `${new URL(current).origin}/content/www/us/en/download/785597/123456/intel-arc-graphics-windows.html`;
  const selector = (options, latest) => `<meta name="DownloadVersion" content="${latest}"><select id="version-driver-select">${options.map(([version, url]) => `<option value="${url}">Intel Graphics Driver ${version}</option>`).join('')}</select>`;
  const pages = new Map([
    [current, selector([
      [current9000, '/content/www/us/en/download/785597/111111/intel-arc-graphics-windows.html'],
      [overlap, '/content/www/us/en/download/785597/222222/intel-arc-graphics-windows.html'],
    ], current9000)],
    [historical, selector([
      [overlap, '/content/www/us/en/download/785597/333333/intel-arc-graphics-windows.html'],
      [archived, new URL(detailUrl).pathname],
    ], overlap)],
    [detailUrl, `<meta name="DownloadVersion" content="${archived}"><p>Intel Graphics Driver ${archived}</p><div>Size: 1.25 GB</div>`],
  ]);
  const service = createIntelDriverUpdateService({ fetchImpl: async (url) => {
    const body = pages.get(url);
    if (!body) throw new Error(`unexpected URL: ${url}`);
    return response(body, url);
  } });

  const catalog = await service.library('arc');
  assert.deepEqual(catalog, { versions: [current9000, overlap, archived], partial: false });
  const release = await service.resolveRelease('arc', archived);
  assert.equal(release.version, archived);
  assert.equal(release.officialPageUrl, detailUrl);
  assert.equal(release.sizeBytes, Math.round(1.25 * 1024 ** 3));
  assert.equal(validIntelDriverReleaseUrl(detailUrl, 'arc'), true);
  assert.equal(validIntelDriverReleaseUrl(
    'https://www.intel.com/content/www/us/en/download/741626/123456/intel-arc-pro-graphics-windows.html',
    'pro',
  ), true);
  assert.equal(validIntelDriverReleaseUrl(detailUrl, 'pro'), false);
  assert.equal(validIntelDriverReleaseUrl(detailUrl.replace('www.intel.com', 'evil.example'), 'arc'), false);
});

test('Intel driver library keeps readable current releases and marks an unavailable history source partial', async () => {
  const current = INTEL_DRIVER_PAGES.pro.officialPageUrl;
  const version = '32.0.101.8805';
  const html = `<meta name="DownloadVersion" content="${version}"><select id="version-driver-select"><option value="/content/www/us/en/download/741626/123456/intel-arc-pro-graphics-windows.html">Intel Graphics Driver ${version}</option></select>`;
  const service = createIntelDriverUpdateService({ fetchImpl: async (url) => {
    if (url === INTEL_DRIVER_PAGES.pro.historicalPageUrl) throw new Error('history unavailable');
    if (url !== current) throw new Error(`unexpected URL: ${url}`);
    return response(html, url);
  } });

  assert.deepEqual(await service.library('pro'), { versions: [version], partial: true });
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
  assert.match(preload, /openIntelDriverDownloadPage:\s*\(kind, version\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-download-page-open',\s*kind,\s*version\)/);
  assert.match(preload, /intelDriverDownloadStatus:\s*\(kind, version\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-download-status',\s*kind,\s*version\)/);
  assert.match(preload, /intelDriverDownloadStart:\s*\(kind, version, acceptedIntelLicense\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-download-start',\s*kind,\s*version,\s*acceptedIntelLicense\)/);
  assert.match(preload, /intelDriverDownloadDelete:\s*\(kind, version\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-download-delete',\s*kind,\s*version\)/);
  assert.match(preload, /intelDriverInstall:\s*\(kind, version\)\s*=>\s*ipcRenderer\.invoke\('intel-driver-install',\s*kind,\s*version\)/);
  assert.match(preload, /onIntelDriverDownloadProgress:\s*\(cb\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\('intel-driver-download:progress'/);
  assert.doesNotMatch(preload, /openIntelDriverDownloadPage:\s*\(url\)/);
  assert.doesNotMatch(preload, /intelDriverDownloadStart:\s*\((?:url|filePath)\)/);
});
