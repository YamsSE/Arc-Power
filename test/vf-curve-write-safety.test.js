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
  writeTransform = (points) => points,
} = {}) {
  const writes = [];
  const scalarWrites = [];
  const nativeEvents = [];
  const libs = {
    ctlOverclockReadVFCurve(_handle, type, _details, countBuffer, pointsBuffer) {
      nativeEvents.push(pointsBuffer === null ? `read-${type}-count` : `read-${type}-table`);
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
      nativeEvents.push('write');
      const size = koffi.sizeof('ctl_voltage_frequency_point_t');
      const writtenPoints = Array.from({ length: count }, (_, index) =>
        koffi.decode(pointsBuffer, index * size, 'ctl_voltage_frequency_point_t'));
      live.splice(0, live.length, ...writeTransform(writtenPoints));
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockWaiverSet() {
      nativeEvents.push('waiver');
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetGetV2(_handle, buffer) {
      nativeEvents.push('get-frequency-offset');
      koffi.encode(buffer, 'double', frequencyOffset);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetGetV2(_handle, buffer) {
      nativeEvents.push('get-voltage-offset');
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
      voltageStepV: 0.001,
      frequencyStepMhz: 10,
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
  return { backend, writes, scalarWrites, nativeEvents, live };
}

function sequenceLiveReads(backend, samples) {
  const nativeRead = backend._readVfCurvePoints.bind(backend);
  let index = 0;
  backend._readVfCurvePoints = (handle, type = 1, details = 0) => {
    if (type !== 1 || index >= samples.length) return nativeRead(handle, type, details);
    return { ok: true, points: samples[index++].map((point) => ({ ...point })) };
  };
}

test('a valid one-shot LIVE before-image is sufficient for the no-op check', async () => {
  const { backend, writes } = fixture();
  sequenceLiveReads(backend, [liveDefault]);
  const result = await backend.applySettings(0, { vfCurve: canonical(liveDefault) });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(result.perControl.vfCurve.readBackCurve, canonical(liveDefault));
  assert.deepEqual(writes, []);
});

test('an invalid LIVE before-image refuses the curve write without a quorum error', async () => {
  const malformed = [
    { Voltage: 700, Frequency: 1100 },
    { Voltage: 900, Frequency: 2100 },
    { Voltage: 800, Frequency: 2600 },
  ];
  const { backend, writes } = fixture({ live: malformed });
  const result = await backend.applySettings(0, { vfCurve: canonical(stock) });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unverified');
  assert.doesNotMatch(result.perControl.vfCurve.message, /read quorum/);
  assert.deepEqual(writes, []);
});

test('B580 exact LIVE curve is a no-op without native writes', async () => {
  const live = liveDefault.map((point) => ({ ...point }));
  const { backend, writes } = fixture({ driverVersion: knownUnsafeDriverVersion, live });
  const result = await backend.applySettings(0, { vfCurve: canonical(live) });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, []);
});

test('B580 exact off-grid LIVE curve is acknowledged without native writes', async () => {
  const live = liveDefault.map((point) => ({ ...point }));
  live[1].Frequency = 2105;
  live[2].Frequency = 2605;
  const { backend, writes } = fixture({ driverVersion: knownUnsafeDriverVersion, live });
  const result = await backend.applySettings(0, { vfCurve: canonical(live) });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, [], 'an already-matching curve needs no grid validation or setter');
});

test('B580 rejects fractional coordinates before sending a native write', async () => {
  const { backend, writes, scalarWrites } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const roundedLookalike = canonical(liveDefault);
  roundedLookalike[0].voltageV += 0.0004;
  roundedLookalike[1].freqMhz += 0.4;
  const result = await backend.applySettings(0, { vfCurve: roundedLookalike });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'out-of-range');
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, []);
});

test('B580 refuses a frequency outside the driver-reported 10 MHz grid before writing', async () => {
  const { backend, writes, scalarWrites } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const offGrid = canonical(liveDefault);
  offGrid[2].freqMhz = 2595;
  const result = await backend.applySettings(0, { vfCurve: offGrid });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'out-of-range');
  assert.match(result.perControl.vfCurve.message, /driver voltage and frequency steps/);
  assert.deepEqual(writes, []);
  assert.deepEqual(scalarWrites, []);
});

test('B580 exact custom-curve profile no-op still blocks conflicting offsets', async () => {
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

test('B580 submits changed custom curves and withholds conflicting profile offsets', async () => {
  const { backend, writes, scalarWrites, nativeEvents, live } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const requested = [
    { voltageV: 0.75, freqMhz: 1500 },
    { voltageV: 0.85, freqMhz: 2200 },
    { voltageV: 0.95, freqMhz: 2700 },
  ];
  await backend.restoreWaiverState(0, true);
  const result = await backend.applySettings(0, {
    vfCurve: requested,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 25,
  }, { profileApply: true });

  assert.equal(result.ok, false, 'dependent profile offsets remain withheld for a custom curve');
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.equal(result.perControl.gpuFreqOffsetMhz.errorCode, 'dependency-failed');
  assert.equal(result.perControl.gpuVoltOffsetV.errorCode, 'dependency-failed');
  assert.deepEqual(writes, ['vf']);
  assert.deepEqual(scalarWrites, [], 'conflicting core offsets are not written');
  assert.equal(nativeEvents.filter((event) => event === 'waiver').length, 1);
  assert.equal(nativeEvents[nativeEvents.indexOf('write') - 1], 'waiver', 'replay the accepted waiver immediately before the one curve write');
  assert.deepEqual(canonical(live), requested);
});

test('B580 STOCK profile submits and verifies the exact driver STOCK table', async () => {
  const { backend, writes, live } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical }, { profileApply: true });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, ['vf']);
  assert.deepEqual(canonical(live), stockCanonical);
});

test('B580 reports a valid driver-remapped curve as normalized success', async () => {
  const requested = [
    { voltageV: 0.75, freqMhz: 1500 },
    { voltageV: 0.85, freqMhz: 2200 },
    { voltageV: 0.95, freqMhz: 2700 },
  ];
  const { backend, writes } = fixture({
    driverVersion: knownUnsafeDriverVersion,
    writeTransform: (points) => points.map((point) => ({
      Voltage: point.Voltage + 1,
      Frequency: point.Frequency + 10,
    })),
  });
  const result = await backend.applySettings(0, { vfCurve: requested });

  assert.equal(result.ok, true);
  assert.equal(result.perControl.vfCurve.errorCode, undefined);
  assert.equal(result.perControl.vfCurve.readBackEqual, false);
  assert.equal(result.perControl.vfCurve.normalized, true);
  assert.equal(result.perControl.vfCurve.ok, true);
  assert.deepEqual(result.perControl.vfCurve.readBackCurve, requested.map((point) => ({
    voltageV: point.voltageV + 0.001,
    freqMhz: point.freqMhz + 10,
  })));
  assert.deepEqual(writes, ['vf']);
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
