import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_RESULT } from '../src/main/backend/igcl-bindings.js';

const stock = [
  { Voltage: 700, Frequency: 1000 },
  { Voltage: 800, Frequency: 2000 },
  { Voltage: 900, Frequency: 2500 },
];
const liveDefault = [
  { Voltage: 700, Frequency: 1100 },
  { Voltage: 800, Frequency: 2100 },
  { Voltage: 900, Frequency: 2600 },
];
const canonical = (points) => points.map((point) => ({
  voltageV: point.Voltage / 1000,
  freqMhz: point.Frequency,
}));
const stockCanonical = canonical(stock);
const knownUnsafeDriverVersion = '0x0020000000652349';

function fixture({
  driverVersion = '0x0000000000000001',
  live = liveDefault.map((point) => ({ ...point })),
  frequencyOffset = 0,
  voltageOffset = 0,
} = {}) {
  const writes = [];
  const scalarWrites = [];
  const libs = {
    ctlOverclockReadVFCurve(_handle, type, _details, countBuffer, pointsBuffer) {
      const points = type === 0 ? stock : live;
      if (pointsBuffer === null) {
        koffi.encode(countBuffer, 'uint32', points.length);
        return CTL_RESULT.SUCCESS;
      }
      const size = koffi.sizeof('ctl_voltage_frequency_point_t');
      points.forEach((point, index) => {
        koffi.encode(pointsBuffer, index * size, 'ctl_voltage_frequency_point_t', point);
      });
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockWriteCustomVFCurve(_handle, count, pointsBuffer) {
      writes.push('vf');
      const size = koffi.sizeof('ctl_voltage_frequency_point_t');
      live.splice(0, live.length, ...Array.from({ length: count }, (_, index) =>
        koffi.decode(pointsBuffer, index * size, 'ctl_voltage_frequency_point_t')));
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetGetV2(_handle, buffer) {
      koffi.encode(buffer, 'double', frequencyOffset);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetGetV2(_handle, buffer) {
      koffi.encode(buffer, 'double', voltageOffset);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetSetV2() {
      scalarWrites.push('frequency');
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetSetV2() {
      scalarWrites.push('voltage');
      return CTL_RESULT.SUCCESS;
    },
  };
  const caps = {
    deviceName: 'Intel Arc B580 Graphics',
    controls: {
      vfCurve: true,
      gpuFreqOffset: true,
      gpuVoltOffset: true,
      gpuLock: false,
    },
    controlStatus: { vfCurve: { state: 'available', reason: null } },
    vfCurveRange: {
      voltageMinV: 0.4,
      voltageMaxV: 1.5,
      freqMinMhz: 400,
      freqMaxMhz: 4300,
      maxPoints: 32,
    },
    ranges: {
      gpuFreqOffsetMhz: { min: -100, max: 100, step: 1, default: 0, units: 'MHz' },
      gpuVoltOffsetV: { min: 0, max: 100, step: 1, default: 0, units: '%' },
    },
  };
  const backend = new IgclBackend({ lib: libs, findDll: () => null });
  backend._device = async () => ({
    handle: 'fake-adapter',
    name: caps.deviceName,
    pciDeviceId: '0x0000e20b',
    driverVersion,
  });
  backend.getCapabilities = async () => caps;
  backend._ocUnitsOf = async () => ({ gpuFreqOffset: 0, gpuVoltOffset: 11 });
  return { backend, writes, scalarWrites, live };
}

test('known unsafe B580 driver keeps an exact LIVE curve as a no-op without native writes', async () => {
  const live = liveDefault.map((point) => ({ ...point }));
  const { backend, writes } = fixture({ driverVersion: knownUnsafeDriverVersion, live });
  const result = await backend.applySettings(0, { vfCurve: canonical(live) });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, []);
});

test('known unsafe B580 driver rejects fractional points that round to the LIVE curve', async () => {
  const { backend, writes, scalarWrites } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const roundedLookalike = canonical(liveDefault);
  roundedLookalike[0].voltageV += 0.0004;
  roundedLookalike[1].freqMhz += 0.4;
  const result = await backend.applySettings(0, { vfCurve: roundedLookalike });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'vf-write-blocked');
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, []);
});

test('known unsafe B580 exact custom-curve profile no-op still blocks conflicting offsets', async () => {
  const { backend, writes, scalarWrites } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const result = await backend.applySettings(0, {
    vfCurve: canonical(liveDefault),
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, true, 'the matching LIVE curve is acknowledged without writing');
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, [], 'the profile cannot change offsets after treating the custom curve as a no-op');
});

test('B580 profile refuses core offsets while VF capability is unavailable', async () => {
  const { backend, writes, scalarWrites } = fixture();
  const caps = await backend.getCapabilities(0);
  caps.controls.vfCurve = false;
  caps.controlStatus.vfCurve = { state: 'unsupported', reason: 'VF surface could not be read' };
  const result = await backend.applySettings(0, {
    vfCurve: canonical(stock),
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'unsupported');
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, [], 'profile offsets are withheld when STOCK identity cannot be read');
});

test('known unsafe B580 driver blocks changed VF and dependent profile offsets before any setter', async () => {
  const { backend, writes, scalarWrites } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'vf-write-blocked');
  assert.match(result.perControl.vfCurve.message, /No VF write was sent/);
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, []);
});

test('malformed finite LIVE before-image prevents a VF write on other driver builds', async () => {
  const malformedLive = [
    { Voltage: 700, Frequency: 1100 },
    { Voltage: 900, Frequency: 2100 },
    { Voltage: 800, Frequency: 2600 },
  ];
  const { backend, writes } = fixture({ live: malformedLive });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unverified');
  assert.deepEqual(writes, []);
});

test('combined custom VF and core offset request is refused before either setter', async () => {
  const { backend, writes, scalarWrites } = fixture();
  const result = await backend.applySettings(0, {
    vfCurve: stockCanonical,
    gpuVoltOffsetV: 25,
  });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, [], 'neither part of a conflicting combined request is written');
});

test('non-finite successful offset read-back prevents a VF write', async () => {
  const { backend, writes } = fixture({ voltageOffset: Number.NaN });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'dependency-failed');
  assert.match(result.perControl.vfCurve.message, /could not be read/);
  assert.deepEqual(writes, []);
});
