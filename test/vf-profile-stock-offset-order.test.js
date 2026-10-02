import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { executeApply } from '../src/main/apply-routing.js';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_RESULT } from '../src/main/backend/igcl-bindings.js';

const stock = [
  { Voltage: 700, Frequency: 1000 },
  { Voltage: 800, Frequency: 2000 },
];
const customLive = [
  { Voltage: 700, Frequency: 1100 },
  { Voltage: 800, Frequency: 2100 },
];
const stockCanonical = stock.map((point) => ({ voltageV: point.Voltage / 1000, freqMhz: point.Frequency }));

function fixture({
  writeResult = CTL_RESULT.SUCCESS,
  adjustReadBack = false,
  stockReadUnavailable = false,
  stockReadSequence = null,
  liveReadUnavailable = false,
  activeOffsets = {},
} = {}) {
  const live = customLive.map((point) => ({ ...point }));
  const calls = [];
  const offsets = { gpuFreqOffset: 0, gpuVoltOffset: 0, ...activeOffsets };
  let stockReadIndex = 0;
  const lib = {
    ctlOverclockReadVFCurve(_handle, type, _details, countBuffer, pointsBuffer) {
      if (type === 0 && stockReadUnavailable) return CTL_RESULT.ERROR_NOT_AVAILABLE;
      if (type === 1 && liveReadUnavailable) return CTL_RESULT.ERROR_DATA_READ;
      const points = type === 0
        ? (stockReadSequence?.[Math.min(stockReadIndex, stockReadSequence.length - 1)] ?? stock)
        : live;
      if (pointsBuffer === null) {
        koffi.encode(countBuffer, 'uint32', points.length);
        return CTL_RESULT.SUCCESS;
      }
      if (type === 0 && Array.isArray(stockReadSequence)) stockReadIndex += 1;
      const size = koffi.sizeof('ctl_voltage_frequency_point_t');
      points.forEach((point, index) => {
        koffi.encode(pointsBuffer, index * size, 'ctl_voltage_frequency_point_t', point);
      });
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockWriteCustomVFCurve(_handle, count, pointsBuffer) {
      calls.push('vf-write');
      if (writeResult !== CTL_RESULT.SUCCESS) return writeResult;
      const size = koffi.sizeof('ctl_voltage_frequency_point_t');
      live.length = 0;
      for (let index = 0; index < count; index += 1) {
        live.push(koffi.decode(pointsBuffer, index * size, 'ctl_voltage_frequency_point_t'));
      }
      if (adjustReadBack) live[0].Frequency += 1;
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetSetV2(_handle, value) {
      calls.push('frequency-offset');
      offsets.gpuFreqOffset = value;
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetGetV2(_handle, buffer) {
      koffi.encode(buffer, 'double', offsets.gpuFreqOffset);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetSetV2(_handle, value) {
      calls.push('voltage-offset');
      offsets.gpuVoltOffset = value;
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetGetV2(_handle, buffer) {
      koffi.encode(buffer, 'double', offsets.gpuVoltOffset);
      return CTL_RESULT.SUCCESS;
    },
  };
  const caps = {
    deviceName: 'Intel Arc B580 Graphics',
    overclockingSupported: true,
    extendedRanges: false,
    controls: {
      vfCurve: true,
      gpuFreqOffset: true,
      gpuVoltOffset: true,
      gpuLock: false,
    },
    controlStatus: { vfCurve: { state: 'available' } },
    vfCurveRange: {
      voltageMinV: 0.4,
      voltageMaxV: 1.5,
      freqMinMhz: 400,
      freqMaxMhz: 4300,
      voltageStepV: 0.001,
      frequencyStepMhz: 1,
      maxPoints: 32,
    },
    ranges: {
      gpuFreqOffsetMhz: { min: -100, max: 100, step: 1, default: 0, units: 'MHz' },
      gpuVoltOffsetV: { min: 0, max: 100, step: 1, default: 0, units: '%' },
    },
  };
  const backend = new IgclBackend({ lib, findDll: () => null });
  backend._device = async () => ({ handle: 'fake-adapter', name: caps.deviceName });
  backend.getCapabilities = async () => caps;
  backend.getCurrentSettings = async () => ({ vfCurve: customLive.map((point) => ({ voltageV: point.Voltage / 1000, freqMhz: point.Frequency })) });
  backend._ocUnitsOf = async () => ({ gpuFreqOffset: 0, gpuVoltOffset: 11 });
  return { backend, calls, live, offsets, caps };
}

test('B580 STOCK profile restores its curve before applying saved scalar core offsets', async () => {
  const { backend, calls, live, offsets } = fixture();
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.deepEqual(calls, ['vf-write', 'frequency-offset', 'voltage-offset']);
  assert.deepEqual(live, stock);
  assert.equal(offsets.gpuFreqOffset, 75);
  assert.equal(offsets.gpuVoltOffset, 25);
});

test('B580 profile treats the first valid differing STOCK as custom without rebasing', async () => {
  const transient = stock.map((point) => ({ ...point, Voltage: point.Voltage + 50 }));
  const { backend, calls, offsets } = fixture({
    stockReadSequence: [transient, stock, stock, stock, stock, stock],
  });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.deepEqual(calls, ['vf-write']);
  assert.deepEqual(offsets, { gpuFreqOffset: 0, gpuVoltOffset: 0 });
});

test('B580 profile uses valid STOCK snapshots without requiring a quorum', async () => {
  const unstable = Array.from({ length: 5 }, (_, read) => stock.map((point, index) => ({
    ...point,
    Voltage: point.Voltage + read + index + 1,
  })));
  const { backend, calls, offsets } = fixture({ stockReadSequence: [stock, ...unstable, stock] });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.deepEqual(calls, ['vf-write', 'frequency-offset', 'voltage-offset']);
  assert.deepEqual(offsets, { gpuFreqOffset: 75, gpuVoltOffset: 25 });
});

test('B580 STOCK profile leaves existing core offsets untouched when curve apply refuses them', async () => {
  const { backend, calls, offsets } = fixture({ activeOffsets: { gpuVoltOffset: 35 } });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.match(result.perControl.vfCurve.message, /reset both core offsets to zero, then apply the profile again/i);
  assert.deepEqual(calls, [], 'a refused curve must not be preceded by scalar core-offset setters');
  assert.equal(offsets.gpuFreqOffset, 0);
  assert.equal(offsets.gpuVoltOffset, 35);
});

test('custom VF profile reports incompatible non-zero offsets instead of silently dropping them', async () => {
  const { backend, calls, offsets } = fixture();
  const customCurve = [
    { voltageV: 0.7, freqMhz: 1050 },
    { voltageV: 0.8, freqMhz: 2050 },
  ];
  const result = await backend.applySettings(0, {
    vfCurve: customCurve,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(calls, ['vf-write']);
  assert.equal(offsets.gpuFreqOffset, 0);
  assert.equal(offsets.gpuVoltOffset, 0);
});

test('custom VF profile applies explicit zero offsets before writing its curve', async () => {
  const { backend, calls, live, offsets } = fixture({
    activeOffsets: { gpuFreqOffset: 25, gpuVoltOffset: 10 },
  });
  const customCurve = [
    { voltageV: 0.7, freqMhz: 1150 },
    { voltageV: 0.8, freqMhz: 2150 },
  ];
  const result = await backend.applySettings(0, {
    vfCurve: customCurve,
    gpuFreqOffsetMhz: 0,
    gpuVoltOffsetV: 0,
  }, { profileApply: true });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.gpuFreqOffsetMhz.readBackEqual, true);
  assert.equal(result.perControl.gpuVoltOffsetV.readBackEqual, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(calls, ['frequency-offset', 'voltage-offset', 'vf-write']);
  assert.deepEqual(offsets, { gpuFreqOffset: 0, gpuVoltOffset: 0 });
  assert.deepEqual(live, [
    { Voltage: 700, Frequency: 1150 },
    { Voltage: 800, Frequency: 2150 },
  ]);
});

test('B580 scalar core offsets are skipped when the requested STOCK curve fails verification', async () => {
  const { backend, calls } = fixture({ writeResult: CTL_RESULT.ERROR_DATA_WRITE });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(calls, ['vf-write'], 'a native VF write is never automatically replayed');
});

test('B580 adjusted STOCK read-back is accepted as LIVE but withholds scalar core offsets', async () => {
  const { backend, calls } = fixture({ adjustReadBack: true });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false, 'dependent non-zero offsets remain withheld');
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.normalized, true);
  assert.equal(result.perControl.vfCurve.errorCode, undefined);
  assert.equal(result.perControl.vfCurve.readBackEqual, false);
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(calls, ['vf-write'], 'offset setters do not follow a non-exact STOCK restore');
});

test('the next apply of the accepted LIVE curve is a no-op, not a repeated remap', async () => {
  const { backend, calls, live } = fixture({ adjustReadBack: true });
  const requestedCurve = [
    { voltageV: 0.7, freqMhz: 1150 },
    { voltageV: 0.8, freqMhz: 2150 },
  ];

  const first = await backend.applySettings(0, { vfCurve: requestedCurve });
  assert.equal(first.perControl.vfCurve.ok, true);
  assert.equal(first.perControl.vfCurve.driverAdjusted, true);
  assert.deepEqual(first.perControl.vfCurve.readBackCurve, [
    { voltageV: 0.7, freqMhz: 1151 },
    { voltageV: 0.8, freqMhz: 2150 },
  ]);
  assert.deepEqual(calls, ['vf-write']);

  const second = await backend.applySettings(0, {
    vfCurve: first.perControl.vfCurve.readBackCurve,
  });
  assert.equal(second.perControl.vfCurve.ok, true);
  assert.equal(second.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(calls, ['vf-write'], 'the stable LIVE curve must not be written again');
  assert.deepEqual(live, [
    { Voltage: 700, Frequency: 1151 },
    { Voltage: 800, Frequency: 2150 },
  ]);
});

test('B580 profile refuses VF and dependent offsets when STOCK preflight cannot be read', async () => {
  const { backend, calls, offsets } = fixture({ stockReadUnavailable: true });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false, 'an unidentified profile curve is not written');
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unverified');
  assert.equal(result.perControl.gpuFreqOffsetMhz.ok, false);
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.ok, false);
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(calls, [], 'curve and offset setters are withheld when STOCK state is unknown');
  assert.equal(offsets.gpuFreqOffset, 0);
  assert.equal(offsets.gpuVoltOffset, 0);
});

test('routed STOCK profile apply refuses VF and offsets when STOCK identity is unavailable', async () => {
  const { backend, calls, caps } = fixture({ stockReadUnavailable: true });
  const out = await executeApply({
    backend,
    oldIgcl: null,
    deviceId: 0,
    settings: {
      vfCurve: stockCanonical,
      gpuFreqOffsetMhz: 75,
      gpuVoltOffsetV: 25,
    },
    opts: { profileApply: true },
    ranges: caps.ranges,
    sleep: async () => {},
  });

  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.vfCurve.ok, false, 'profile policy refuses an unidentified curve');
  assert.equal(out.result.perControl.vfCurve.errorCode, 'readback-unverified');
  assert.equal(out.result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(out.result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(calls, [], 'routed profile writes stay withheld when STOCK identity is unknown');
});

test('executeApply repairs an exact legacy scalar curve before splitting extended controls', async () => {
  const stockReference = [
    { voltageV: 0.7, freqMhz: 1000 },
    { voltageV: 0.8, freqMhz: 2000 },
  ];
  const backendCalls = [];
  const extendedCalls = [];
  const caps = {
    deviceName: 'Intel Arc B580 Graphics',
    overclockingSupported: true,
    extendedRanges: true,
    controls: { vfCurve: true, gpuFreqOffset: true, gpuVoltOffset: true },
    controlStatus: { vfCurve: { state: 'available' } },
    vfCurveRange: {
      voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300,
      voltageStepV: 0.001, frequencyStepMhz: 1, maxPoints: 32,
    },
    ranges: {
      powerLimitW: { min: 100, max: 130, step: 1, default: 100, units: '%' },
      tempLimitC: { min: 0, max: 110, step: 1, default: 90, units: 'C' },
      gpuFreqOffsetMhz: { min: -1000, max: 1000, step: 1, default: 0, units: 'MHz' },
      gpuVoltOffsetV: { min: -100, max: 100, step: 1, default: 0, units: '%' },
    },
  };
  const backend = {
    async getCapabilities() { return caps; },
    async getCurrentSettings() { return {}; },
    async applySettings(_deviceId, settings) {
      backendCalls.push(settings);
      return {
        ok: true,
        perControl: Object.fromEntries(Object.keys(settings).map((key) => [key, { ok: true, readBackEqual: true }])),
      };
    },
  };
  const oldIgcl = {
    async isCapable() { return true; },
    async isTempCapable() { return true; },
    async setTempLimitC(value) { extendedCalls.push(['tempLimitC', value]); return { ok: true, readBackEqual: true }; },
  };
  const settings = {
    powerLimitW: 114,
    gpuVoltOffsetV: 35,
    gpuFreqOffsetMhz: 150,
    tempLimitC: 95,
    vfCurveStockReference: stockReference,
    vfCurve: stockReference.map((point) => ({ ...point, freqMhz: point.freqMhz + 150 })),
  };
  const out = await executeApply({
    backend,
    oldIgcl,
    deviceId: 0,
    settings,
    opts: { profileApply: true },
    ocMode: 'advanced',
    sleep: async () => {},
    delayedVerifyMs: 0,
  });

  assert.equal(out.result.ok, true);
  assert.deepEqual(backendCalls, [{ powerLimitW: 114, gpuVoltOffsetV: 35, gpuFreqOffsetMhz: 150 }]);
  assert.deepEqual(extendedCalls, [['tempLimitC', 95]]);
  assert.equal(backendCalls.some((payload) => 'vfCurve' in payload), false, 'the legacy VF setter must not receive the baked curve');
});

test('a STOCK-only profile marker refreshes the driver curve and clears offsets before resetting it', async () => {
  const stockCurve = [
    { voltageV: 0.7, freqMhz: 1000 },
    { voltageV: 0.8, freqMhz: 2000 },
  ];
  const backendCalls = [];
  const caps = {
    deviceName: 'Intel Arc B580 Graphics', overclockingSupported: true, extendedRanges: true,
    controls: { vfCurve: true, gpuFreqOffset: true, gpuVoltOffset: true },
    controlStatus: { vfCurve: { state: 'available' } },
    vfCurveRange: { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300,
      voltageStepV: 0.001, frequencyStepMhz: 1, maxPoints: 32 },
    ranges: {
      powerLimitW: { min: 100, max: 130, step: 1, default: 100, units: '%' },
      gpuFreqOffsetMhz: { min: -1000, max: 1000, step: 1, default: 0, units: 'MHz' },
      gpuVoltOffsetV: { min: -100, max: 100, step: 1, default: 0, units: '%' },
    },
  };
  const backend = {
    async getCapabilities() { return caps; },
    async getCurrentSettings() { return { vfCurve: stockCurve, vfCurveDefault: stockCurve }; },
    async applySettings(_deviceId, settings) {
      backendCalls.push(settings);
      return {
        ok: true,
        perControl: Object.fromEntries(Object.keys(settings).map((key) => [key, { ok: true, readBackEqual: true }])),
      };
    },
  };
  const out = await executeApply({
    backend,
    oldIgcl: null,
    deviceId: 0,
    settings: {
      powerLimitW: 114,
      gpuVoltOffsetV: 0,
      gpuFreqOffsetMhz: 0,
      vfCurveProfileStock: true,
    },
    opts: { profileApply: true },
    ocMode: 'advanced',
    sleep: async () => {},
    delayedVerifyMs: 0,
  });

  assert.equal(out.result.ok, true);
  assert.deepEqual(backendCalls[0], { gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0 },
    'the active scalar surface is verified clear before VF reset');
  assert.deepEqual(backendCalls[1], {
    powerLimitW: 114,
    gpuVoltOffsetV: 0,
    gpuFreqOffsetMhz: 0,
    vfCurve: stockCurve,
    vfCurveResetToDefault: true,
  });
  assert.equal(backendCalls.some((payload) => 'vfCurveProfileStock' in payload), false,
    'profile metadata never reaches the backend control payload');
});

test('a STOCK-only profile marker refuses before writes when fresh driver STOCK is unreadable', async () => {
  const backendCalls = [];
  const stockCurve = [
    { voltageV: 0.7, freqMhz: 1000 },
    { voltageV: 0.8, freqMhz: 2000 },
  ];
  const caps = {
    deviceName: 'Intel Arc B580 Graphics', overclockingSupported: true,
    controls: { vfCurve: true },
    vfCurveRange: { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300,
      voltageStepV: 0.001, frequencyStepMhz: 1, maxPoints: 32 },
  };
  const backend = {
    async getCapabilities() { return caps; },
    async getCurrentSettings() { return { vfCurve: stockCurve, vfCurveDefault: null }; },
    async applySettings(_deviceId, settings) { backendCalls.push(settings); return { ok: true, perControl: {} }; },
  };
  const out = await executeApply({
    backend, oldIgcl: null, deviceId: 0,
    settings: { gpuVoltOffsetV: 0, gpuFreqOffsetMhz: 0, vfCurveProfileStock: true },
    opts: { profileApply: true },
  });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.vfCurve.errorCode, 'readback-unverified');
  assert.deepEqual(backendCalls, [], 'the rest of the profile is withheld with no trusted STOCK curve');
});

test('B580 VF writes stop when the LIVE before-image cannot be verified', async () => {
  const { backend, calls } = fixture({ liveReadUnavailable: true });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unverified');
  assert.deepEqual(calls, [], 'no native write is sent without a verified before-image');
});

test('B580 VF writes stop while either active GPU core offset is non-zero', async () => {
  const { backend, calls } = fixture({ activeOffsets: { gpuVoltOffset: 35 } });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'dependency-failed');
  assert.match(result.perControl.vfCurve.message, /offsets to zero/);
  assert.deepEqual(calls, [], 'no VF write is sent while a conflicting core offset remains active');
});
