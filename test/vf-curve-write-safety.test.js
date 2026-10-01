import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { battlemageVfCurveCapability, IgclBackend } from '../src/main/backend/igcl-backend.js';
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
  frequencyOffsetReads = null,
  voltageOffsetReads = null,
  writeTransform = (points) => points,
} = {}) {
  const writes = [];
  const scalarWrites = [];
  const nativeEvents = [];
  const frequencyOffsetSequence = frequencyOffsetReads ?? [frequencyOffset];
  const voltageOffsetSequence = voltageOffsetReads ?? [voltageOffset];
  let frequencyOffsetReadIndex = 0;
  let voltageOffsetReadIndex = 0;
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
      const value = frequencyOffsetSequence[Math.min(frequencyOffsetReadIndex++, frequencyOffsetSequence.length - 1)];
      koffi.encode(buffer, 'double', value);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetGetV2(_handle, buffer) {
      nativeEvents.push('get-voltage-offset');
      const value = voltageOffsetSequence[Math.min(voltageOffsetReadIndex++, voltageOffsetSequence.length - 1)];
      koffi.encode(buffer, 'double', value);
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
  return { backend, writes, scalarWrites, nativeEvents, live, caps };
}

function sequenceCurveReads(backend, type, samples) {
  const nativeRead = backend._readVfCurvePoints.bind(backend);
  let index = 0;
  backend._readVfCurvePoints = (handle, curveType = 1, details = 0) => {
    if (curveType !== type || index >= samples.length) return nativeRead(handle, curveType, details);
    return { ok: true, points: samples[index++].map((point) => ({ ...point })) };
  };
}

function sequenceLiveReads(backend, samples) {
  sequenceCurveReads(backend, 1, samples);
}

test('a matching stable LIVE before-image is sufficient for the no-op check', async () => {
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

test('an unstable LIVE before-image refuses a B580 curve write after the bounded retry', async () => {
  const samples = Array.from({ length: 10 }, (_, read) => liveDefault.map((point, index) => ({
    ...point,
    Voltage: point.Voltage + read + index,
  })));
  const { backend, writes } = fixture();
  sequenceLiveReads(backend, samples);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
  assert.match(result.perControl.vfCurve.message, /stable 3-of-5 read quorum/);
  assert.deepEqual(writes, []);
});

test('an unstable STOCK table refuses a B580 curve write and is never used as a reset source', async () => {
  const unstableStockReads = Array.from({ length: 10 }, (_, read) => stock.map((point, index) => ({
    ...point,
    Voltage: point.Voltage + read + index + 1,
  })));
  const samples = [stock, ...unstableStockReads];
  const { backend, writes } = fixture();
  sequenceCurveReads(backend, 0, samples);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
  assert.match(result.perControl.vfCurve.message, /stable 3-of-5 read quorum/);
  assert.deepEqual(writes, []);
});

test('apply retries stable STOCK reads after a transient initial probe failure', async () => {
  const { backend, writes } = fixture();
  const readWithRetry = backend._readVfCurvePointsWithRetry.bind(backend);
  let firstStockProbe = true;
  backend._readVfCurvePointsWithRetry = async (handle, type = 1, details = 0) => {
    if (type === 0 && firstStockProbe) {
      firstStockProbe = false;
      return { ok: false, retryable: true, fallbackToLive: false, points: [], message: 'transient STOCK read failure' };
    }
    return readWithRetry(handle, type, details);
  };

  const result = await backend.applySettings(0, { vfCurve: canonical(liveDefault) });

  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, []);
});

test('STOCK reset apply can write after a transient initial STOCK probe recovers', async () => {
  const { backend, writes, live } = fixture();
  const readWithRetry = backend._readVfCurvePointsWithRetry.bind(backend);
  let firstStockProbe = true;
  backend._readVfCurvePointsWithRetry = async (handle, type = 1, details = 0) => {
    if (type === 0 && firstStockProbe) {
      firstStockProbe = false;
      return { ok: false, retryable: true, fallbackToLive: false, points: [], message: 'transient STOCK read failure' };
    }
    return readWithRetry(handle, type, details);
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, { vfCurve: stockCanonical });

    assert.equal(result.perControl.vfCurve.ok, true);
    assert.equal(result.perControl.vfCurve.readBackEqual, true);
    assert.deepEqual(result.perControl.vfCurve.readBackCurve, stockCanonical);
    assert.deepEqual(canonical(live), stockCanonical);
    assert.deepEqual(writes, ['vf']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('independently stable STOCK and LIVE reads are rechecked together before the B580 setter', async () => {
  const shiftedStock = stock.map((point) => ({ ...point, Voltage: point.Voltage + 50 }));
  const shiftedLive = liveDefault.map((point) => ({ ...point, Voltage: point.Voltage + 50 }));
  const { backend, writes } = fixture();
  let stockIndex = 0;
  let liveIndex = 0;
  const nativeRead = backend._readVfCurvePoints.bind(backend);
  backend._readVfCurvePoints = (_handle, type = 1, details = 0) => {
    if (type === 0) {
      const index = stockIndex++;
      return { ok: true, points: (index <= 5 ? stock : shiftedStock).map((point) => ({ ...point })) };
    }
    if (type === 1) {
      const index = liveIndex++;
      return { ok: true, points: (index < 5 ? shiftedLive : liveDefault).map((point) => ({ ...point })) };
    }
    return nativeRead(_handle, type, details);
  };

  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
  assert.match(result.perControl.vfCurve.message, /STOCK\/LIVE VF source changed after preflight/);
  assert.deepEqual(writes, []);
});

test('getCurrentSettings keeps a stable STOCK reference visible when LIVE is unstable', async () => {
  const { backend, caps } = fixture();
  backend.getCapabilities = async () => caps;
  backend._fanHandlesOf = async () => [];
  let liveIndex = 0;
  const nativeRead = backend._readVfCurvePoints.bind(backend);
  backend._readVfCurvePoints = (_handle, type = 1, details = 0) => {
    if (type === 0) return { ok: true, points: stock.map((point) => ({ ...point })) };
    if (type === 1 && liveIndex < 10) {
      const index = liveIndex++;
      const shiftedLive = liveDefault.map((point) => ({ ...point, Voltage: point.Voltage + index + 1 }));
      return { ok: true, points: shiftedLive };
    }
    return nativeRead(_handle, type, details);
  };

  const state = await backend.getCurrentSettings(0);

  assert.deepEqual(state.vfCurveDefault, canonical(stock));
  assert.equal(state.vfCurve, null);
});

test('getCurrentSettings retries stable STOCK reads after a transient initial probe failure', async () => {
  const { backend, caps } = fixture();
  backend.getCapabilities = async () => caps;
  backend._fanHandlesOf = async () => [];
  const readWithRetry = backend._readVfCurvePointsWithRetry.bind(backend);
  let firstStockProbe = true;
  backend._readVfCurvePointsWithRetry = async (handle, type = 1, details = 0) => {
    if (type === 0 && firstStockProbe) {
      firstStockProbe = false;
      return { ok: false, retryable: true, fallbackToLive: false, points: [], message: 'transient STOCK read failure' };
    }
    return readWithRetry(handle, type, details);
  };

  const state = await backend.getCurrentSettings(0);

  assert.deepEqual(state.vfCurveDefault, stockCanonical);
  assert.deepEqual(state.vfCurve, canonical(liveDefault));
});

test('LIVE-only driver fallback never advertises LIVE as the STOCK reset curve', async () => {
  const { backend, caps } = fixture();
  backend.getCapabilities = async () => caps;
  backend._fanHandlesOf = async () => [];
  backend._readVfCurvePointsWithRetry = async (_handle, type) => type === 0
    ? { ok: false, fallbackToLive: true, message: 'STOCK read surface unavailable' }
    : { ok: true, points: liveDefault.map((point) => ({ ...point })) };

  const state = await backend.getCurrentSettings(0);

  assert.equal(state.vfCurveDefault, null);
  assert.deepEqual(state.vfCurve, canonical(liveDefault));
});

test('a transient failed LIVE preflight quorum retries and then writes once', async () => {
  const unstable = Array.from({ length: 5 }, (_, read) => liveDefault.map((point) => ({
    ...point,
    Voltage: point.Voltage + read + 1,
  })));
  const { backend, writes } = fixture();
  sequenceLiveReads(backend, [...unstable, ...Array(5).fill(liveDefault)]);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, ['vf']);
});

test('a changed STOCK source after waiver replay refuses the setter', async () => {
  const changedStock = stock.map((point) => ({ ...point }));
  changedStock[1].Frequency += 10;
  const { backend, writes, nativeEvents } = fixture();
  sequenceCurveReads(backend, 0, [...Array(6).fill(stock), changedStock]);
  await backend.restoreWaiverState(0, true);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
  assert.match(result.perControl.vfCurve.message, /STOCK\/LIVE VF source changed after preflight/);
  assert.deepEqual(writes, []);
  assert.equal(nativeEvents.filter((event) => event === 'waiver').length, 1);
});

test('a changed LIVE before-image after waiver replay refuses the setter', async () => {
  const changedLive = liveDefault.map((point) => ({ ...point }));
  changedLive[1].Frequency += 10;
  const { backend, writes, nativeEvents } = fixture();
  sequenceLiveReads(backend, [...Array(5).fill(liveDefault), changedLive]);
  await backend.restoreWaiverState(0, true);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.perControl.vfCurve.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
  assert.deepEqual(writes, []);
  assert.equal(nativeEvents.filter((event) => event === 'waiver').length, 1);
});

test('a core offset that changes after final curve reads refuses the setter', async (t) => {
  for (const scenario of [
    { name: 'frequency', options: { frequencyOffsetReads: [0, 50] } },
    { name: 'voltage', options: { voltageOffsetReads: [0, 10] } },
  ]) {
    await t.test(scenario.name, async () => {
      const { backend, writes, nativeEvents } = fixture(scenario.options);
      await backend.restoreWaiverState(0, true);
      const result = await backend.applySettings(0, { vfCurve: stockCanonical });

      assert.equal(result.perControl.vfCurve.ok, false);
      assert.equal(result.perControl.vfCurve.errorCode, 'dependency-failed');
      assert.match(result.perControl.vfCurve.message, /changed while preparing/);
      assert.deepEqual(writes, []);
      assert.equal(nativeEvents.at(-1), 'get-voltage-offset');
    });
  }
});

test('getCapabilities keeps B580 VF controls visible after a refused probe and unstable STOCK preflight never writes', async () => {
  const probeReason = 'VF STOCK read failed (ERROR_KMD_CALL)';
  const supportedInfo = (units, min, max, step, Default = 0) => ({
    bSupported: true,
    bRelative: true,
    bReference: false,
    units,
    min,
    max,
    step,
    Default,
    reference: 0,
  });
  const unsupportedInfo = {
    bSupported: false,
    bRelative: false,
    bReference: false,
    units: 0,
    min: 0,
    max: 0,
    step: 0,
    Default: 0,
    reference: 0,
  };
  const properties = {
    Size: koffi.sizeof('ctl_oc_properties_t'),
    Version: 1,
    bSupported: true,
    gpuFrequencyOffset: supportedInfo(0, -100, 100, 1),
    gpuVoltageOffset: supportedInfo(11, 0, 100, 1),
    vramFrequencyOffset: unsupportedInfo,
    vramVoltageOffset: unsupportedInfo,
    powerLimit: unsupportedInfo,
    temperatureLimit: unsupportedInfo,
    vramMemSpeedLimit: unsupportedInfo,
    gpuVFCurveVoltageLimit: supportedInfo(3, 0.4, 1.5, 0.001, 0.7),
    gpuVFCurveFrequencyLimit: supportedInfo(0, 400, 4300, 10, 1000),
  };
  const lib = {
    ctlOverclockGetProperties(_handle, buffer) {
      koffi.encode(buffer, 'ctl_oc_properties_t', properties);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetGetV2() {},
    ctlOverclockGpuFrequencyOffsetSetV2() {},
    ctlOverclockGpuMaxVoltageOffsetGetV2() {},
    ctlOverclockGpuMaxVoltageOffsetSetV2() {},
    ctlOverclockReadVFCurve() {},
    ctlOverclockWriteCustomVFCurve() {},
  };
  const capabilityBackend = new IgclBackend({ lib, findDll: () => null });
  capabilityBackend._device = async () => ({
    handle: 'fake-adapter',
    name: 'Intel Arc B580 Graphics',
    pciDeviceId: '0x0000e20b',
    driverVersion: 'test-driver',
  });
  capabilityBackend._vfCurveReadable = async () => ({
    ok: false,
    state: 'runtime-refused',
    reason: probeReason,
  });
  const capability = await capabilityBackend.getCapabilities(0);
  assert.equal(capability.controls.vfCurve, true);
  assert.deepEqual(capability.controlStatus.vfCurve, { state: 'runtime-refused', reason: probeReason });

  const unstableStockReads = Array.from({ length: 10 }, (_, read) => stock.map((point, index) => ({
    ...point,
    Voltage: point.Voltage + read + index + 1,
  })));
  const { backend, writes } = fixture();
  backend.getCapabilities = async () => capability;
  sequenceCurveReads(backend, 0, unstableStockReads);
  const result = await backend.applySettings(0, { vfCurve: canonical(liveDefault) });

  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
  assert.deepEqual(writes, [], 'runtime capability visibility must not bypass stable STOCK write preflight');
});

test('Battlemage VF remains unsupported when either IGCL symbol is missing or for other adapters', () => {
  assert.equal(battlemageVfCurveCapability({ battlemage: true, readAvailable: false, writeAvailable: true }).supported, false);
  assert.equal(battlemageVfCurveCapability({ battlemage: true, readAvailable: true, writeAvailable: false }).supported, false);
  assert.equal(battlemageVfCurveCapability({ battlemage: false, readAvailable: true, writeAvailable: true }).supported, false);
});

test('overlapping B580 applies serialize through each LIVE read-back', async () => {
  const { backend, writes } = fixture();
  const firstCurve = canonical(liveDefault);
  firstCurve[1].freqMhz += 10;
  const secondCurve = canonical(liveDefault);
  secondCurve[2].freqMhz += 10;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const [first, second] = await Promise.all([
      backend.applySettings(0, { vfCurve: firstCurve }),
      backend.applySettings(0, { vfCurve: secondCurve }),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(first.perControl.vfCurve.readBackCurve, firstCurve);
    assert.deepEqual(second.perControl.vfCurve.readBackCurve, secondCurve);
    assert.deepEqual(writes, ['vf', 'vf']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
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

test('B580 sends an IGS-precision integer MHz edit and verifies the resulting LIVE curve', async () => {
  const { backend, writes, scalarWrites, live } = fixture({ driverVersion: knownUnsafeDriverVersion });
  const oneMHzEdit = canonical(liveDefault);
  oneMHzEdit[2].freqMhz = 2595;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, { vfCurve: oneMHzEdit });

    assert.equal(result.perControl.vfCurve.ok, true);
    assert.equal(result.perControl.vfCurve.readBackEqual, true);
    assert.deepEqual(result.perControl.vfCurve.readBackCurve, oneMHzEdit);
    assert.deepEqual(canonical(live), oneMHzEdit);
    assert.deepEqual(writes, ['vf']);
    assert.deepEqual(scalarWrites, []);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('B580 accepts only a stable one-step driver remap of an IGS-precision edit', async () => {
  const { backend, writes, live } = fixture({
    driverVersion: knownUnsafeDriverVersion,
    writeTransform: (points) => points.map((point, index) => ({
      ...point,
      Frequency: index === 2 ? 2590 : point.Frequency,
    })),
  });
  const oneMHzEdit = canonical(liveDefault);
  oneMHzEdit[2].freqMhz = 2595;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, { vfCurve: oneMHzEdit });

    assert.equal(result.perControl.vfCurve.ok, true);
    assert.equal(result.perControl.vfCurve.normalized, true);
    assert.equal(result.perControl.vfCurve.readBackEqual, false);
    assert.deepEqual(result.perControl.vfCurve.readBackCurve[2], {
      voltageV: oneMHzEdit[2].voltageV,
      freqMhz: 2590,
    });
    assert.deepEqual(writes, ['vf']);
    assert.deepEqual(canonical(live), result.perControl.vfCurve.readBackCurve);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
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
  const waiverIndex = nativeEvents.indexOf('waiver');
  const writeIndex = nativeEvents.indexOf('write');
  assert.deepEqual(nativeEvents.slice(waiverIndex + 1, writeIndex), [
    'read-0-count', 'read-0-table', 'read-1-count', 'read-1-table',
    'get-frequency-offset', 'get-voltage-offset',
  ], 'replay the accepted waiver before the final STOCK/LIVE source snapshot and the one curve write');
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

test('B580 adopts a valid driver-remapped curve and does not submit it again', async () => {
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
  assert.equal(result.perControl.vfCurve.driverAdjusted, true);
  const appliedCurve = requested.map((point) => ({
    voltageV: point.voltageV + 0.001,
    freqMhz: point.freqMhz + 10,
  }));
  assert.deepEqual(result.perControl.vfCurve.readBackCurve, appliedCurve);
  assert.deepEqual(writes, ['vf']);

  const repeated = await backend.applySettings(0, { vfCurve: appliedCurve });
  assert.equal(repeated.perControl.vfCurve.ok, true);
  assert.equal(repeated.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, ['vf'], 'a later Apply of LIVE state must be a no-op');
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
