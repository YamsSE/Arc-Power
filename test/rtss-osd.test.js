import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRtssTelemetryText, createRtssOsdPublisher, encodeRtssGraphObject } from '../src/main/rtss-osd.js';

const makeMap = (version = 0x2000E, owner = '', busy = 0, entrySize = version >= 0x2000C ? 266752 : version >= 0x20007 ? 4608 : 512, count = 2) => {
  const offset = 40;
  const map = Buffer.alloc(offset + entrySize * count);
  map.writeUInt32LE(0x52545353, 0);
  map.writeUInt32LE(version, 4);
  map.writeUInt32LE(0, 8); map.writeUInt32LE(0, 12); map.writeUInt32LE(0, 16);
  map.writeUInt32LE(entrySize, 20); map.writeUInt32LE(offset, 24); map.writeUInt32LE(2, 28);
  map.writeUInt32LE(7, 32); map.writeUInt32LE(count, 28); map.writeUInt32LE(busy, 36);
  if (owner) map.write(owner, offset + entrySize + 256, 'ascii');
  return { map, entrySize, offset };
};

test('formatter emits RTSS-native tags and keeps telemetry values bounded', () => {
  const args = {
    telemetry: {
      t: 1,
      deviceKey: 'pci-a',
      deviceName: 'Arc B580',
      cpuUtilPct: 42,
      cpuFreqMhz: 4300,
      cpuTempC: 61,
      cpuPowerW: 125.5,
      memoryUsedBytes: 12_400_000_000,
      gpuClockMhz: 2500,
      memClockMhz: 2187,
      tempC: 65,
      vramTempC: 73,
      gpuVoltageV: 0.652,
      powerW: 38.8,
      utilPct: 88,
      fanRpm: [1030],
      gpuMemUsedBytes: 4_096_000_000,
      api: 'DX12<>',
    },
    fps: { fps: 144.4, avgFps: 140, low1Pct: 99, low01Pct: 88, p99: 101, frameTimeMs: 6.94 },
    settings: {
      scale: 2,
      position: 'bottom-right',
      color: '#12abef',
      overlayChipNames: true,
      stats: [
        'fps', 'fps-avg', 'fps-1pct-low', 'fps-01pct-low', 'fps-99pct',
        'cpu-util', 'cpu-clock', 'cpu-temp', 'cpu-power', 'memory-util',
        'gpu-util', 'gpu-clock', 'gpu-voltage', 'gpu-temp', 'gpu-power', 'gpu-fan',
        'gpu-mem-clock', 'gpu-vram', 'gpu-vram-temp', 'api', 'frametime',
      ],
    },
  };
  const first = buildRtssTelemetryText(args);
  assert.equal(first, buildRtssTelemetryText(args));
  assert.match(first, /<P8><FNT=Consolas,8,400,4><C0=12ABEF><C0>/);
  assert.match(first, /Arc B580/);
  assert.match(first, /CPU 42% 4\.3 GHz 61C 125\.5 W/);
  assert.match(first, /VRAM1 2187 MHz 4 GB 73C/);
  assert.match(first, /API DX12\\<\\>/);
  assert.doesNotMatch(first, /[\x00\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/);
  assert.ok(Buffer.byteLength(first, 'ascii') <= 4095);
});

test('formatter respects legacy text mode without leaking format tags', () => {
  const text = buildRtssTelemetryText({
    telemetry: { cpuUtilPct: 42, gpuClockMhz: 2000, tempC: 60 },
    settings: { stats: ['cpu-util', 'gpu-clock', 'gpu-temp'] },
    formatTagsSupported: false,
  });
  assert.equal(text, 'CPU 42%\nGPU1 2000 MHz 60C');
  assert.doesNotMatch(text, /<[^>]+>/);
});

test('graph encoder bounds samples, raises the graph height, and writes RTSS header', () => {
  const graph = encodeRtssGraphObject({ values: Array.from({ length: 700 }, (_, index) => index) });
  assert.equal(graph.readUInt32LE(0), 0x47523030);
  assert.equal(graph.readUInt32LE(32), 512);
  assert.equal(graph.readInt32LE(12), -6);
  assert.equal(graph.readUInt32LE(20), 0);
  assert.equal(graph.readUInt32LE(4), graph.length);
});

test('visibility cycles release and reacquire the RTSS slot', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true });
  assert.equal(publisher.publish({ text: 'first' }), true);
  publisher.setVisible(false);
  assert.equal(publisher.getState().available, false);
  publisher.setVisible(true);
  assert.equal(publisher.publish({ text: 'second' }), true);
});

test('dead RTSS mappings are rejected and can be reopened after RTSS restarts', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true });
  assert.equal(publisher.publish({ text: 'live' }), true);
  fixture.map.writeUInt32LE(0x0000DEAD, 0);
  assert.equal(publisher.publish({ text: 'dead' }), false);
  assert.equal(publisher.getState().available, false);
  fixture.map.writeUInt32LE(0x52545353, 0);
  assert.equal(publisher.publish({ text: 'restarted' }), true);
});

test('busy RTSS slots retry a deferred hide and do not leave stale text behind', async () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true });
  assert.equal(publisher.publish({ text: 'busy-hide' }), true);
  fixture.map.writeUInt32LE(1, 36);
  publisher.setVisible(false);
  assert.equal(publisher.getState().available, true);
  fixture.map.writeUInt32LE(0, 36);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(publisher.getState().available, false);
  assert.equal(fixture.map.toString('ascii', fixture.offset + fixture.entrySize + 256, fixture.offset + fixture.entrySize + 264).replaceAll('\0', ''), '');
});

test('claims reusable slot, publishes extended text, and clears only its owner', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map, unmap: () => {}, close: () => {} });
  assert.equal(publisher.available(), true);
  assert.equal(publisher.getState().slot, 1);
  assert.equal(publisher.publish({ text: 'hello <P0>' }), true);
  assert.equal(fixture.map.toString('ascii', fixture.offset + fixture.entrySize + 512, fixture.offset + fixture.entrySize + 522), 'hello <P0>');
  assert.equal(publisher.clear(), true);
  assert.equal(fixture.map.readUInt32LE(32), 9);
  assert.equal(fixture.map.toString('ascii', fixture.offset + fixture.entrySize + 256, fixture.offset + fixture.entrySize + 264).replaceAll('\0', ''), '');
});

test('merges separately sampled GPUs and applies live selection/stat changes', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true, monitoredDeviceKeys: ['gpu-a', 'gpu-b'], stats: ['gpu-util', 'gpu-vram'] });
  publisher.setKnownDeviceKeys(['gpu-a', 'gpu-b'], ['gpu-a', 'gpu-b']);
  assert.equal(publisher.publish({ telemetry: { t: 1, deviceKey: 'gpu-a', deviceName: 'B580', utilPct: 88, gpuMemUsedBytes: 4_000_000_000 } }), true);
  assert.equal(publisher.publish({ telemetry: { t: 2, deviceKey: 'gpu-b', deviceName: 'A770', utilPct: 44, gpuMemUsedBytes: 6_000_000_000 } }), true);
  const base = fixture.offset + fixture.entrySize + 512;
  const merged = fixture.map.toString('ascii', base, base + 4096).replaceAll('\0', '');
  assert.match(merged, /GPU1 88%/);
  assert.match(merged, /GPU2 44%/);
  assert.match(merged, /VRAM1 4 GB/);
  publisher.updateSettings({ monitoredDeviceKeys: ['gpu-a'], stats: ['gpu-temp'] });
  assert.equal(publisher.publish({ telemetry: { t: 3, deviceKey: 'gpu-a', tempC: 65 } }), true);
  const updated = fixture.map.toString('ascii', base, base + 4096).replaceAll('\0', '');
  assert.match(updated, /GPU1 -%? ?65C|GPU1 65C/);
  assert.doesNotMatch(updated, /VRAM/);
});

test('prunes removed physical GPU samples before the all-GPU view is rendered', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true, stats: ['gpu-util'] });
  assert.equal(publisher.publish({ telemetry: { t: 1, deviceKey: 'gpu-a', utilPct: 88 } }), true);
  assert.equal(publisher.publish({ telemetry: { t: 2, deviceKey: 'gpu-b', utilPct: 44 } }), true);
  publisher.setKnownDeviceKeys(['gpu-a']);
  assert.equal(publisher.publish({ telemetry: { t: 3, cpuUtilPct: 20 } }), true);
  const base = fixture.offset + fixture.entrySize + 512;
  const text = fixture.map.toString('ascii', base, base + 4096).replaceAll('\0', '');
  assert.match(text, /GPU1 88%/);
  assert.doesNotMatch(text, /44%|GPU2/);
});

test('falls back to current GPU rows when the saved selection is stale', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true, monitoredDeviceKeys: ['removed-gpu'], stats: ['gpu-util'] });
  publisher.setKnownDeviceKeys(['replacement-gpu']);
  assert.equal(publisher.publish({ telemetry: { t: 1, deviceKey: 'replacement-gpu', utilPct: 72 } }), true);
  const base = fixture.offset + fixture.entrySize + 512;
  const text = fixture.map.toString('ascii', base, base + 4096).replaceAll('\0', '');
  assert.match(text, /GPU1 72%/);
});

test('preserves RTSS background control bytes and renders themes distinctly', () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true, theme: 'classic', overlayBgEnabled: true, overlayBgColor: '#112233', overlayBgOpacity: 1, stats: ['gpu-util'] });
  assert.equal(publisher.publish({ telemetry: { t: 1, deviceKey: 'gpu-a', utilPct: 88 } }), true);
  const base = fixture.offset + fixture.entrySize + 512;
  const bytes = fixture.map.subarray(base, base + 4096);
  assert.ok(bytes.includes(0x08), 'the RTSS background fill marker must reach shared memory');
  const classic = bytes.toString('ascii').replaceAll('\0', '');
  assert.match(classic, /<FNT=Tahoma,8,700,/);
  publisher.updateSettings({ theme: 'arc', overlayBgEnabled: false });
  assert.equal(publisher.publish({ telemetry: { t: 2, deviceKey: 'gpu-a', utilPct: 77 } }), true);
  const arc = bytes.toString('ascii').replaceAll('\0', '');
  assert.match(arc, /<FNT=Consolas,8,400,/);
  assert.doesNotMatch(arc, /<B=0,0>/);
});

test('publishes embedded frametime graph when the RTSS entry supports it', () => {
  const fixture = makeMap(0x2000E);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true, stats: ['frametime'] });
  assert.equal(publisher.publish({ telemetry: { t: 1, deviceKey: 'gpu-a' }, fps: { frameTimeMs: 16.7 } }), true);
  const base = fixture.offset + fixture.entrySize + 512;
  const text = fixture.map.toString('ascii', base, base + 4096).replaceAll('\0', '');
  assert.match(text, /<OBJ=00000000>/);
  const graph = fixture.map.subarray(fixture.offset + fixture.entrySize + 4608, fixture.offset + fixture.entrySize + 4608 + 40);
  assert.equal(graph.readUInt32LE(0), 0x47523030);
  assert.equal(graph.readInt32LE(12), -6);
  assert.equal(graph.readUInt32LE(32), 1);
  assert.ok(Math.abs(graph.readFloatLE(36) - 16.7) < 0.001);
});

test('refuses a busy mapping and never claims another owner', () => {
  const busy = makeMap(0x2000E, '', 1, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => busy.map });
  assert.equal(publisher.publish({ text: 'nope' }), false);
  const occupied = makeMap(0x2000E, 'SomeoneElse', 0, 4608);
  const other = createRtssOsdPublisher({ open: () => 1, map: () => occupied.map });
  assert.equal(other.available(), false);
  assert.equal(occupied.map.toString('ascii', occupied.offset + occupied.entrySize + 256, occupied.offset + occupied.entrySize + 267).replaceAll('\0', ''), 'SomeoneElse');
});

test('reuses an older ArcPower slot before claiming a new empty slot', async () => {
  const fixture = makeMap(0x2000E, '', 0, 4608, 3);
  const oldBase = fixture.offset + fixture.entrySize * 2;
  fixture.map.write('ArcPower', oldBase + 256, 'ascii');
  fixture.map.write('old HUD', oldBase + 512, 'ascii');
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true });
  assert.equal(publisher.available(), true);
  assert.equal(publisher.getState().slot, 2);
  await publisher.stop();
  assert.equal(fixture.map.toString('ascii', oldBase + 256, oldBase + 264).replaceAll('\0', ''), '');
  assert.equal(fixture.map.toString('ascii', fixture.offset + fixture.entrySize + 256, fixture.offset + fixture.entrySize + 264).replaceAll('\0', ''), '');
});

test('stop drains a deferred FPS read and never republishes after teardown', async () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  let releaseFps;
  const fpsReady = new Promise((resolve) => { releaseFps = resolve; });
  const publisher = createRtssOsdPublisher({
    open: () => 1,
    map: () => fixture.map,
    getFpsSample: async () => fpsReady,
  });
  publisher.updateSettings({ enabled: true, stats: ['gpu-util'] });
  assert.equal(publisher.publish({ text: 'before-stop', fps: null }), true);
  const pending = publisher.publish({ telemetry: { t: 1, deviceKey: 'gpu-a', utilPct: 99 } });
  await Promise.resolve();
  const stopping = publisher.stop();
  releaseFps({ fps: 144, frameTimeMs: 6.9 });
  assert.equal(await pending, false);
  await stopping;
  assert.equal(publisher.getState().available, false);
  assert.equal(fixture.map.toString('ascii', fixture.offset + fixture.entrySize + 256, fixture.offset + fixture.entrySize + 264).replaceAll('\0', ''), '');
  assert.equal(publisher.publish({ text: 'after-stop' }), false);
});

test('stop retries a busy RTSS mapping before releasing its slot', async () => {
  const fixture = makeMap(0x2000E, '', 0, 4608);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => fixture.map });
  publisher.updateSettings({ enabled: true });
  assert.equal(publisher.publish({ text: 'busy-shutdown' }), true);
  fixture.map.writeUInt32LE(1, 36);
  const stopping = publisher.stop();
  setTimeout(() => fixture.map.writeUInt32LE(0, 36), 50);
  await stopping;
  assert.equal(fixture.map.toString('ascii', fixture.offset + fixture.entrySize + 256, fixture.offset + fixture.entrySize + 264).replaceAll('\0', ''), '');
});

test('falls back to legacy text and no-ops malformed or missing mappings', () => {
  const old = makeMap(0x20006, '', 0, 512);
  const publisher = createRtssOsdPublisher({ open: () => 1, map: () => old.map });
  assert.equal(publisher.publish({ text: 'legacy' }), true);
  assert.equal(old.map.toString('ascii', old.offset + old.entrySize, old.offset + old.entrySize + 6), 'legacy');
  const missing = createRtssOsdPublisher({ open: () => 0, map: () => null });
  assert.equal(missing.publish({ text: 'x' }), false);
  const malformed = Buffer.alloc(128);
  malformed.writeUInt32LE(0x52545353, 0); malformed.writeUInt32LE(0x2000E, 4);
  const invalid = createRtssOsdPublisher({ open: () => 1, map: () => malformed });
  assert.equal(invalid.available(), false);
});
