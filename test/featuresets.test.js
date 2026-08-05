// M2D — mock distribution file (mock/featuresets/*.json): parser/validator,
// per-device caps, percent-unit flows, no-OC / no-fan surfaces, the live
// swap round trip (backend + IPC), and the real-mode channel absence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend, createMockOldIgcl } from '../src/main/backend/mock-backend.js';
import {
  DEFAULT_FEATURESET_ID,
  loadFeatureset,
  loadFeaturesetOrFallback,
  listFeaturesetFiles,
  validateFeatureset,
} from '../src/main/backend/featuresets.js';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { TelemetryService } from '../src/main/telemetry/telemetry-service.js';
import { formatValue, snapToRange } from '../src/renderer/pure/slider.ts';
import { computePresets } from '../src/renderer/pure/presets.ts';
import { validateSettingsPayload, clampExposedRange, requiresExtendedRangeConfirm } from '../src/renderer/pure/settings.ts';

const ALL_IDS = ['a770', 'arc-igpu', 'b580', 'pro-b50'];

const fakeStore = () => ({
  loadSettings: async () => ({}),
  loadProfiles: async () => [],
  saveProfile: async () => {},
  deleteProfile: async () => {},
  saveSettings: async () => {},
});

// ---------------------------------------------------------------------------
// parser + validator
// ---------------------------------------------------------------------------

test('M2D: every distribution file parses + validates (id/name/ranges/units)', () => {
  const files = listFeaturesetFiles();
  assert.deepEqual(files.map((f) => f.id).sort(), ALL_IDS);
  for (const id of ALL_IDS) {
    const fs = loadFeatureset(id);
    assert.ok(fs, `featureset '${id}' loaded`);
    assert.equal(fs.id, id);
    assert.ok(fs.name.length > 0, 'name present');
    assert.equal(validateFeatureset(fs), fs);
    assert.ok(fs.tag.length > 0, 'confidence tag present');
  }
  const a770 = loadFeatureset('a770');
  assert.match(a770.tag, /verified/);
  assert.equal(a770.extendedRanges, true);
  assert.equal(a770.extended.plMax, 315);
  assert.equal(a770.extended.tlMax, 115);
  assert.equal(a770.fanCanControl, false);
  assert.equal(a770.numXeCores, 32);
});

test('M2D: missing file -> null + a770 fallback with a warning', () => {
  assert.equal(loadFeatureset('no-such-gpu'), null);
  assert.equal(loadFeatureset(''), null);
  const { featureset, warning } = loadFeaturesetOrFallback('no-such-gpu');
  assert.equal(featureset.id, DEFAULT_FEATURESET_ID);
  assert.match(warning, /no-such-gpu/);
  assert.match(warning, /a770/);
});

test('M2D: validator rejects malformed shapes with clear errors', () => {
  const base = () => JSON.parse(JSON.stringify(loadFeatureset('a770')));
  assert.throws(() => validateFeatureset({ ...base(), id: 'other' }, 'a770'), /does not match/);
  assert.throws(() => validateFeatureset({ ...base(), numXeCores: 0 }), /numXeCores/);
  assert.throws(() => validateFeatureset({ ...base(), extended: { plMax: 0, tlMax: 0 } }), /extended/);
  assert.throws(() => validateFeatureset({ ...base(), fanCanControl: true, hasFan: false }), /hasFan/);
  const badRange = base();
  badRange.ranges.powerLimitW = { units: 'W', min: 105, max: 90, step: 1, default: 210 };
  assert.throws(() => validateFeatureset(badRange), /min<=default<=max/);
  const unsupported = base();
  delete unsupported.ranges.gpuFreqOffsetMhz;
  assert.throws(() => validateFeatureset(unsupported), /exactly when/);
  const unknownControl = base();
  unknownControl.supportedControls.push('turbo');
  assert.throws(() => validateFeatureset(unknownControl), /unknown control/);
});

// ---------------------------------------------------------------------------
// a770 — the verified default
// ---------------------------------------------------------------------------

test('M2D: default mock = a770 featureset (verified matrix)', async () => {
  const b = new MockBackend();
  const caps = await b.getCapabilities(0);
  assert.equal(b.featuresetId, 'a770');
  assert.deepEqual(caps.ranges.gpuFreqOffsetMhz, { min: 0, max: 300, step: 1, default: 0, units: 'MHz' });
  // the a770 featureset carries the extended maxes natively (M2C-C verified)
  assert.deepEqual(caps.ranges.powerLimitW, { min: 105, max: 315, step: 1, default: 210, units: 'W' });
  assert.deepEqual(caps.ranges.tempLimitC, { min: 60, max: 115, step: 1, default: 90, units: 'C' });
  assert.ok(Math.abs(caps.ranges.gpuVoltOffsetV.max - 0.234) < 1e-9);
  assert.equal(caps.extendedRanges, true);
  assert.equal(caps.controls.gpuLock, true);
  assert.equal(caps.controls.vramFreqOffset, false);
  assert.equal(caps.controls.vfCurve, false);
  assert.equal(caps.fan.canControl, false, 'the real card: read-only fan');
  const devices = await b.listDevices();
  assert.equal(devices[0].name, 'Mock Arc A770 Graphics (fixture)');
  assert.equal(devices[0].driverVersion, '32.0.101.8861');
  assert.equal(devices[0].numXeCores, 32);
  assert.equal(devices[0].pciDeviceId, '0x000056a0');
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 210);
  assert.equal(s.tempLimitC, 90);
  assert.deepEqual(s.gpuLock, { voltageV: 0, freqMhz: 0 });
  const h = await b.health();
  assert.match(h.driverVersion, /32\.0\.101\.8861/);
});

test('M2D: telemetry derives from the featureset (a770: base clock 600, mem 2187, fanRpm, 38.8 W)', async () => {
  const b = new MockBackend();
  const s0 = await b.sampleRawTelemetry(0);
  const s1 = await b.sampleRawTelemetry(0);
  assert.equal(s0.gpuClockMhz, 600);
  assert.equal(s1.gpuClockMhz - s0.gpuClockMhz, 100);
  assert.equal(s0.memClockMhz, 2187);
  assert.deepEqual(s0.fanRpm, [1030]);
  assert.ok(Math.abs(s1.gpuEnergyJ - s0.gpuEnergyJ - 19.4) < 1e-6, '38.8 W @ 0.5 s');
});

test('M2D: the monitoring power readout derives from the ACTIVE featureset — a swap changes the wattage', async () => {
  const b = new MockBackend();
  const svc = new TelemetryService(b, 0, { pollMs: 50 });
  const samples = [];
  svc.onSample((s) => samples.push(s));
  svc.handleSample(await b.sampleRawTelemetry(0));
  svc.handleSample(await b.sampleRawTelemetry(0));
  assert.ok(Math.abs(samples[1].powerW - 38.8) < 1e-6, `a770 power readout: ${samples[1].powerW}`);
  await b.setFeatureset('b580'); // 45 W
  svc.handleSample(await b.sampleRawTelemetry(0));
  svc.handleSample(await b.sampleRawTelemetry(0));
  assert.ok(Math.abs(samples[3].powerW - 45) < 1e-6, `b580 power readout after the swap: ${samples[3].powerW}`);
  await b.setFeatureset('arc-igpu'); // 8 W
  svc.handleSample(await b.sampleRawTelemetry(0));
  svc.handleSample(await b.sampleRawTelemetry(0));
  assert.ok(Math.abs(samples[5].powerW - 8) < 1e-6, `iGPU power readout after the swap: ${samples[5].powerW}`);
});

// ---------------------------------------------------------------------------
// b580 — percent units, vfCurve R/W, no gpuLock
// ---------------------------------------------------------------------------

test('M2D: b580 featureset — percent units for volt/PL/TL, Gbps VRAM, vfCurve R/W, no gpuLock, extendedRanges false', async () => {
  const b = new MockBackend({ featureset: loadFeatureset('b580') });
  const caps = await b.getCapabilities(0);
  assert.equal(b.featuresetId, 'b580');
  assert.equal(caps.extendedRanges, undefined);
  assert.deepEqual(caps.ranges.powerLimitW, { min: 0, max: 150, step: 1, default: 100, units: '%' });
  assert.equal(caps.ranges.tempLimitC.units, '%');
  assert.equal(caps.ranges.gpuVoltOffsetV.units, '%');
  assert.equal(caps.ranges.gpuFreqOffsetMhz.units, 'MHz');
  assert.equal(caps.ranges.vramFreqOffsetGts.units, 'Gbps');
  assert.equal(caps.controls.gpuLock, false);
  assert.equal(caps.controls.vfCurve, true);
  assert.equal(caps.controls.vramFreqOffset, true);
  assert.equal(caps.fan.canControl, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 100);
  assert.equal(s.tempLimitC, 100);
  assert.equal(s.gpuLock, null);
  assert.equal(s.vramFreqOffsetGts, 0);
  const devices = await b.listDevices();
  assert.equal(devices[0].numXeCores, 20);
  assert.equal(devices[0].driverVersion, '32.0.140.4109');
});

test('M2D: b580 percent values flow through apply/presets/format/validation', async () => {
  const b = new MockBackend({ featureset: loadFeatureset('b580') });
  const res = await b.applySettings(0, { powerLimitW: 120, tempLimitC: 75, gpuVoltOffsetV: 12, gpuFreqOffsetMhz: 50 });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 120);
  assert.equal(s.tempLimitC, 75);
  assert.equal(s.gpuVoltOffsetV, 12);
  assert.equal(s.gpuFreqOffsetMhz, 50);
  // percent ranges clamp like any other
  const clamped = await b.applySettings(0, { powerLimitW: 999 });
  assert.equal(clamped.ok, true);
  assert.equal((await b.getCurrentSettings(0)).powerLimitW, 150);
  // pure helpers: formatValue / snap / presets / payload validation
  assert.equal(formatValue(120, '%'), '120 %');
  const range = { min: 0, max: 150, step: 1, default: 100, units: '%' };
  assert.equal(snapToRange(128.6, range), 129);
  const presets = computePresets(range);
  assert.ok(presets.some((p) => p.name === 'Stock' && p.value === 100));
  assert.ok(presets.some((p) => p.name === 'Max' && p.value === 150));
  assert.equal(validateSettingsPayload({ powerLimitW: 120, tempLimitC: 75 }), true);
  // the renderer W/C pins must NOT clamp percent-unit ranges (M2D)
  assert.equal(clampExposedRange(range, 'powerLimitW')?.max, 150);
  assert.equal(clampExposedRange({ min: 0, max: 100, step: 1, default: 100, units: '%' }, 'tempLimitC')?.max, 100);
});

test('M2D: requiresExtendedRangeConfirm is unit-aware — percent values never count as extended', () => {
  const percentCaps = {
    ranges: {
      powerLimitW: { min: 0, max: 150, step: 1, default: 100, units: '%' },
      tempLimitC: { min: 0, max: 100, step: 1, default: 100, units: '%' },
    },
  };
  // b580 defaults/applies: no extended confirm even though 100 > 90 numerically.
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 120, tempLimitC: 100 }, percentCaps), false);
  // W-unit caps keep the M2C-C gate.
  const wCaps = {
    ranges: {
      powerLimitW: { min: 105, max: 315, step: 1, default: 210, units: 'W' },
      tempLimitC: { min: 60, max: 115, step: 1, default: 90, units: 'C' },
    },
  };
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 300 }, wCaps), true);
  assert.equal(requiresExtendedRangeConfirm({ tempLimitC: 100 }, wCaps), true);
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 220, tempLimitC: 90 }, wCaps), false);
  // no caps -> the historical behavior (backward compatible).
  assert.equal(requiresExtendedRangeConfirm({ tempLimitC: 100 }), true);
});

test('M2D: b580 vfCurve applies (R/W) and gpuLock applies fail unsupported', async () => {
  const b = new MockBackend({ featureset: loadFeatureset('b580') });
  const vf = await b.applySettings(0, {
    vfCurve: [{ voltageV: 0.9, freqMhz: 1800 }, { voltageV: 1.0, freqMhz: 2000 }],
  });
  assert.equal(vf.ok, true);
  assert.equal(vf.perControl.vfCurve.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.vfCurve?.length, 2);
  assert.equal(s.vfCurve?.[1].freqMhz, 2000);
  const lock = await b.applySettings(0, { gpuLock: { voltageV: 0.9, freqMhz: 2100 } });
  assert.equal(lock.ok, false);
  assert.equal(lock.perControl.gpuLock.errorCode, 'unsupported');
});

// ---------------------------------------------------------------------------
// pro-b50 / arc-igpu — no OC
// ---------------------------------------------------------------------------

test('M2D: pro-b50 — no OC controls, fan only; apply with no controls is a clean no-op', async () => {
  const b = new MockBackend({ featureset: loadFeatureset('pro-b50') });
  const caps = await b.getCapabilities(0);
  assert.deepEqual(caps.ranges, {});
  assert.equal(Object.values(caps.controls).some(Boolean), false);
  assert.equal(caps.fan.canControl, true);
  const noop = await b.applySettings(0, {});
  assert.equal(noop.ok, true);
  assert.deepEqual(noop.perControl, {});
  const refused = await b.applySettings(0, { powerLimitW: 100 });
  assert.equal(refused.ok, false);
  assert.equal(refused.perControl.powerLimitW.errorCode, 'unsupported');
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, null);
  assert.equal(s.tempLimitC, null);
  const devices = await b.listDevices();
  assert.equal(devices[0].numXeCores, 20);
});

test('M2D: arc-igpu — telemetry-only, no fan', async () => {
  const b = new MockBackend({ featureset: loadFeatureset('arc-igpu') });
  const caps = await b.getCapabilities(0);
  assert.deepEqual(caps.ranges, {});
  assert.equal(caps.fan.canControl, false);
  assert.deepEqual(caps.fan.modes, []);
  assert.equal(caps.fan.maxCurvePoints, 0);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanMode, null);
  assert.equal(s.fanCurve, null);
  const tel = await b.sampleRawTelemetry(0);
  assert.equal(tel.fanRpm, null);
  assert.equal(tel.memClockMhz, 1067);
  // the fan overlay cannot turn a fan-less device fan-editable
  const forced = new MockBackend({ featureset: loadFeatureset('arc-igpu'), fanCanControl: true });
  assert.equal((await forced.getCapabilities(0)).fan.canControl, false);
});

// ---------------------------------------------------------------------------
// swap round trip (backend level)
// ---------------------------------------------------------------------------

test('M2D: setFeatureset swaps caps/state/device/health and back (waiver preserved)', async () => {
  const b = new MockBackend();
  await b.setWaiverAccepted(0);
  const out = await b.setFeatureset('b580');
  assert.equal(out.featureset.id, 'b580');
  assert.equal(out.featureset.name, 'Arc B580 (Battlemage)');
  assert.equal(out.caps.ranges.powerLimitW.units, '%');
  assert.equal(out.state.powerLimitW, 100, 'state resets to the new device defaults');
  assert.equal(out.devices[0].name, 'Mock Arc B580 Graphics (fixture)');
  assert.match(out.health.driverVersion, /32\.0\.140\.4109/);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true, 'app-level waiver survives the swap');
  const back = await b.setFeatureset('a770');
  assert.equal(back.featureset.id, 'a770');
  assert.equal(back.state.powerLimitW, 210);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
});

test('M2D: listFeaturesets enumerates the distribution files + current selection', async () => {
  const b = new MockBackend();
  const list = await b.listFeaturesets();
  assert.deepEqual(list.featuresets.map((f) => f.id).sort(), ALL_IDS);
  assert.equal(list.current, 'a770');
});

test('M2D: setFeatureset with an unknown id falls back to a770 (never crashes)', async () => {
  const b = new MockBackend();
  const out = await b.setFeatureset('no-such-gpu');
  assert.equal(out.featureset.id, 'a770');
  assert.equal(out.state.powerLimitW, 210);
});

test('M2D: the swap payload carries the featureset driver date — no stale boot date on the card', async () => {
  const b = new MockBackend(); // boot: a770, registry date 7-5-2026
  assert.equal(b._featureset.driverDate, '7-5-2026');
  // b580: unverified driver -> the swap must NULL the card date.
  const out = await b.setFeatureset('b580');
  assert.equal(out.driverDate, null, 'estimated featureset: no driver date');
  // back to a770: the verified date returns with the a770 surface.
  const back = await b.setFeatureset('a770');
  assert.equal(back.driverDate, '7-5-2026', 'a770: the verified registry date');
});

// ---------------------------------------------------------------------------
// IPC surface: mock channels in mock mode, ABSENT in real mode
// ---------------------------------------------------------------------------

test('M2D: mock:list-featuresets / mock:set-featureset exist ONLY in mock mode', async () => {
  const real = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal('mock:list-featuresets' in real.handlers, false, 'real mode: no such channel (honest 404)');
  assert.equal('mock:set-featureset' in real.handlers, false);

  const b = new MockBackend();
  const mockCtl = {
    listFeaturesets: () => b.listFeaturesets(),
    setFeatureset: (id) => b.setFeatureset(id),
  };
  const mock = createIpcHandlers({ backend: b, store: fakeStore(), emit: () => {}, mock: mockCtl });
  assert.ok('mock:list-featuresets' in mock.handlers);
  assert.ok('mock:set-featureset' in mock.handlers);
});

test('M2D: the swap round-trips through the IPC handler (caps + state + store payload)', async () => {
  const b = new MockBackend();
  const mockCtl = {
    listFeaturesets: () => b.listFeaturesets(),
    setFeatureset: (id) => b.setFeatureset(id),
  };
  const { handlers } = createIpcHandlers({ backend: b, store: fakeStore(), emit: () => {}, mock: mockCtl });
  const list = await handlers['mock:list-featuresets']();
  assert.equal(list.current, 'a770');
  assert.equal(list.featuresets.length, 4);
  const out = await handlers['mock:set-featureset']('b580');
  assert.equal(out.featureset.id, 'b580');
  assert.equal(out.caps.ranges.powerLimitW.units, '%');
  assert.equal(out.state.powerLimitW, 100);
  await assert.rejects(() => handlers['mock:set-featureset'](''), /non-empty string/);
  await assert.rejects(() => handlers['mock:set-featureset'](42), /non-empty string/);
  await assert.rejects(() => handlers['mock:list-featuresets']({}), /takes no payload/);
});

// ---------------------------------------------------------------------------
// the RID_MOCK_* overlays keep working on top of the featureset
// ---------------------------------------------------------------------------

test('M2D: the ui-verify overlays still work on the featureset base', async () => {
  // RID_MOCK_FAN_READONLY overlay on the a770 base (already read-only -> idempotent).
  const readonly = new MockBackend({ fanCanControl: false });
  assert.equal((await readonly.getCapabilities(0)).fan.canControl, false);
  // RID_MOCK_EXTENDED_RANGES overlay: force extended on a non-extended base.
  const forced = new MockBackend({ featureset: loadFeatureset('b580'), extendedRanges: true });
  const caps = await forced.getCapabilities(0);
  assert.equal(caps.extendedRanges, true);
  assert.equal(caps.ranges.powerLimitW.max, 150, 'b580 has no extended block — the % range stays');
  // RID_MOCK_EXTENDED_FAIL still makes the old-runtime mock answer honestly.
  const failing = new MockBackend({ extendedFail: true });
  const old = createMockOldIgcl(failing);
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false);
  assert.match(per.message, /2023 IGCL runtime/);
});
