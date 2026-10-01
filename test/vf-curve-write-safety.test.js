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
  let currentFrequencyOffset = frequencyOffset;
  let currentVoltageOffset = voltageOffset;
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
      const value = frequencyOffsetReadIndex < frequencyOffsetSequence.length
        ? frequencyOffsetSequence[frequencyOffsetReadIndex++]
        : currentFrequencyOffset;
      koffi.encode(buffer, 'double', value);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetGetV2(_handle, buffer) {
      nativeEvents.push('get-voltage-offset');
      const value = voltageOffsetReadIndex < voltageOffsetSequence.length
        ? voltageOffsetSequence[voltageOffsetReadIndex++]
        : currentVoltageOffset;
      koffi.encode(buffer, 'double', value);
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuFrequencyOffsetSetV2(_handle, value) {
      scalarWrites.push('frequency');
      currentFrequencyOffset = value;
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGpuMaxVoltageOffsetSetV2(_handle, value) {
      scalarWrites.push('voltage');
      currentVoltageOffset = value;
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

test('B580 capability probe accepts one successful count and payload read', async () => {
  const { backend, nativeEvents } = fixture();
  const probe = await backend._vfCurveReadable('fake-adapter');
  assert.equal(probe.ok, true);
  assert.deepEqual(nativeEvents, ['read-0-count', 'read-0-table']);
});

test('B580 passive state reads STOCK and LIVE once each', async () => {
  const { backend, nativeEvents } = fixture();
  backend._fanHandlesOf = async () => [];
  const state = await backend.getCurrentSettings(0);
  assert.deepEqual(state.vfCurveDefault, stockCanonical);
  assert.deepEqual(state.vfCurve, canonical(liveDefault));
  assert.deepEqual(nativeEvents.filter((event) => event.startsWith('read-')), ['read-0-count', 'read-0-table', 'read-1-count', 'read-1-table']);
});

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
  assert.equal(result.perControl.vfCurve.errorCode, 'driver-invalid-readback');
  assert.doesNotMatch(result.perControl.vfCurve.message, /read quorum/);
  assert.deepEqual(writes, []);
});

test('B580 accepts origins 670 to 795 mV without quorum or draft rebasing', async () => {
  const { backend, writes, live } = fixture();
  const shifted = (points, origin) => points.map((point) => ({ ...point, Voltage: point.Voltage - points[0].Voltage + origin }));
  sequenceLiveReads(backend, [shifted(liveDefault, 670), shifted(liveDefault, 795)]);
  sequenceCurveReads(backend, 0, [shifted(stock, 776), shifted(stock, 670)]);
  const requested = stock.map((point) => ({ ...point })); requested[1].Frequency -= 10;
  const result = await backend.applySettings(0, { vfCurve: canonical(requested) });
  assert.equal(result.ok, true); assert.deepEqual(writes, ['vf']);
  assert.deepEqual(live, requested, 'custom coordinates pass through unchanged');
});

test('B580 reset uses the final fresh STOCK snapshot with a moving origin', async () => {
  const { backend, writes, live } = fixture();
  const fresh = stock.map((point) => ({ ...point, Voltage: point.Voltage + 95 }));
  sequenceCurveReads(backend, 0, [stock, fresh]);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical, vfCurveResetToDefault: true });
  assert.equal(result.ok, true); assert.deepEqual(writes, ['vf']); assert.deepEqual(live, fresh);
});

test('apply retries stable STOCK reads after a transient initial probe failure', async () => {
  const { backend, writes } = fixture();
  const readWithRetry = backend._readVfCurvePoints.bind(backend);
  let firstStockProbe = true;
  backend._readVfCurvePoints = (handle, type = 1, details = 0) => {
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
  const readWithRetry = backend._readVfCurvePoints.bind(backend);
  let firstStockProbe = true;
  backend._readVfCurvePoints = (handle, type = 1, details = 0) => {
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

test('explicit reset intent writes a fresh STOCK table instead of the cached renderer curve', async () => {
  const staleRendererCurve = canonical(liveDefault);
  const { backend, writes, live } = fixture();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, {
      vfCurve: staleRendererCurve,
      vfCurveResetToDefault: true,
    });

    assert.equal(result.perControl.vfCurve.ok, true);
    assert.equal(result.perControl.vfCurve.readBackEqual, true);
    assert.deepEqual(result.perControl.vfCurve.readBackCurve, stockCanonical);
    assert.deepEqual(canonical(live), stockCanonical);
    assert.deepEqual(writes, ['vf']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('a profile curve with a uniform four millivolt edit is preserved as custom', async () => {
  const customCurve = stockCanonical.map((point) => ({ ...point, voltageV: point.voltageV + 0.004 }));
  const { backend, writes, live } = fixture();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, { vfCurve: customCurve }, { profileApply: true });

    assert.equal(result.perControl.vfCurve.ok, true);
    assert.equal(result.perControl.vfCurve.readBackEqual, true);
    assert.deepEqual(canonical(live), customCurve);
    assert.deepEqual(writes, ['vf']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('profile payloads cannot use the transient reset marker to replace a custom curve', async () => {
  const customCurve = canonical(liveDefault);
  customCurve[2].freqMhz -= 10;
  const { backend, writes, live } = fixture();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, {
      vfCurve: customCurve,
      vfCurveResetToDefault: true,
    }, { profileApply: true });

    assert.equal(result.perControl.vfCurve.ok, true);
    assert.deepEqual(canonical(live), customCurve);
    assert.deepEqual(writes, ['vf']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('B580 submits once then confirms the latest effective STOCK and LIVE result', async () => {
  const { backend, writes, nativeEvents } = fixture();
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });
  assert.equal(result.ok, true); assert.deepEqual(writes, ['vf']);
  assert.deepEqual(nativeEvents.slice(nativeEvents.indexOf('write') + 1),
    Array.from({ length: 6 }, () => ['read-0-count', 'read-0-table', 'read-1-count', 'read-1-table']).flat());
  assert.equal(nativeEvents.filter((event) => event === 'read-0-table').length, 8);
  assert.equal(nativeEvents.filter((event) => event === 'read-1-table').length, 8);
});

test('B580 never retries a failed native setter', async () => {
  const { backend, writes } = fixture();
  backend._libOrThrow().ctlOverclockWriteCustomVFCurve = () => {
    writes.push('vf');
    return CTL_RESULT.ERROR_KMD_CALL;
  };
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });
  assert.equal(result.ok, false);
  assert.deepEqual(writes, ['vf']);
});

test('B580 rejects an invalid postwrite LIVE table without replaying its setter', async () => {
  const { backend, writes } = fixture({
    writeTransform: (points) => points.map((point, index) => ({ ...point, Voltage: index === 1 ? points[0].Voltage : point.Voltage })),
  });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });
  assert.equal(result.ok, false);
  assert.equal(result.perControl.vfCurve.errorCode, 'driver-invalid-readback');
  assert.deepEqual(writes, ['vf']);
});

test('B580 bounds postwrite native read errors without replaying the setter', async () => {
  const { backend, writes } = fixture();
  const nativeRead = backend._readVfCurvePoints.bind(backend);
  let failedReads = 0;
  backend._readVfCurvePoints = (handle, type, details) => {
    if (writes.length && type === 1) {
      failedReads += 1;
      return { ok: false, retryable: true, points: [], message: 'native LIVE read error' };
    }
    return nativeRead(handle, type, details);
  };
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });
  assert.equal(result.ok, false);
  assert.equal(failedReads, 3);
  assert.deepEqual(writes, ['vf']);
});

test('getCurrentSettings accepts one valid LIVE sample with a moving voltage origin', async () => {
  const { backend, caps } = fixture();
  backend.getCapabilities = async () => caps;
  backend._fanHandlesOf = async () => [];
  let liveIndex = 0;
  const nativeRead = backend._readVfCurvePoints.bind(backend);
  backend._readVfCurvePoints = (_handle, type = 1, details = 0) => {
    if (type === 0) return { ok: true, points: stock.map((point) => ({ ...point })) };
    if (type === 1 && liveIndex < 10) {
      const index = liveIndex++;
      const shiftedLive = liveDefault.map((point) => ({ ...point, Voltage: point.Voltage + index * 5 + 1 }));
      return { ok: true, points: shiftedLive };
    }
    return nativeRead(_handle, type, details);
  };

  const state = await backend.getCurrentSettings(0);

  assert.deepEqual(state.vfCurveDefault, canonical(stock));
  assert.deepEqual(state.vfCurve, canonical(liveDefault.map((point) => ({ ...point, Voltage: point.Voltage + 1 }))));
});

test('getCurrentSettings retries stable STOCK reads after a transient initial probe failure', async () => {
  const { backend, caps } = fixture();
  backend.getCapabilities = async () => caps;
  backend._fanHandlesOf = async () => [];
  const readWithRetry = backend._readVfCurvePoints.bind(backend);
  let firstStockProbe = true;
  backend._readVfCurvePoints = (handle, type = 1, details = 0) => {
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

test('a changing LIVE origin does not block one valid apply snapshot', async () => {
  const unstable = Array.from({ length: 5 }, (_, read) => liveDefault.map((point) => ({
    ...point,
    Voltage: point.Voltage + read * 5 + 1,
  })));
  const { backend, writes } = fixture();
  sequenceLiveReads(backend, [unstable[0], unstable[1]]);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });

  assert.equal(result.perControl.vfCurve.ok, true);
  assert.equal(result.perControl.vfCurve.readBackEqual, true);
  assert.deepEqual(writes, ['vf']);
});

test('a genuine STOCK or LIVE frequency or spacing change after waiver refuses the setter', async (t) => {
  for (const type of [0, 1]) {
    for (const field of ['Frequency', 'Voltage']) {
      await t.test(`${type === 0 ? 'STOCK' : 'LIVE'} ${field}`, async () => {
        const prior = type === 0 ? stock : liveDefault;
        const changed = prior.map((point) => ({ ...point }));
        changed[1][field] += 10;
        const { backend, writes } = fixture();
        sequenceCurveReads(backend, type, [prior, changed]);
        const result = await backend.applySettings(0, { vfCurve: stockCanonical });
        assert.equal(result.ok, false);
        assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable');
        assert.deepEqual(writes, []);
      });
    }
  }
});

test('an invalid final LIVE source after waiver refuses the setter', async () => {
  const changed = liveDefault.map((point) => ({ ...point })); changed[1].Voltage = changed[0].Voltage;
  const { backend, writes } = fixture(); sequenceLiveReads(backend, [liveDefault, changed]);
  const result = await backend.applySettings(0, { vfCurve: stockCanonical });
  assert.equal(result.perControl.vfCurve.ok, false); assert.equal(result.perControl.vfCurve.errorCode, 'readback-unstable'); assert.deepEqual(writes, []);
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

test('getCapabilities keeps B580 VF visible and valid dynamic STOCK permits apply', async () => {
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
    Voltage: point.Voltage + read * 5 + index + 1,
  })));
  const { backend, writes } = fixture();
  backend.getCapabilities = async () => capability;
  sequenceCurveReads(backend, 0, unstableStockReads);
  const result = await backend.applySettings(0, { vfCurve: canonical(liveDefault) });

  assert.equal(result.ok, true);
  assert.deepEqual(writes, []);
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

test('B580 STOCK profile permits core offsets after a verified uniform four millivolt readback shift', async () => {
  const { backend, writes, scalarWrites, live } = fixture({
    writeTransform: (points) => points.map((point) => ({ ...point, Voltage: point.Voltage + 4 })),
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const result = await backend.applySettings(0, {
      vfCurve: stockCanonical,
      gpuFreqOffsetMhz: 10,
      gpuVoltOffsetV: 5,
    }, { profileApply: true });

    assert.equal(result.ok, true);
    assert.equal(result.perControl.vfCurve.ok, true);
    assert.equal(result.perControl.vfCurve.readBackEqual, false);
    assert.equal(result.perControl.vfCurve.normalized, true);
    assert.equal(result.perControl.vfCurve.uniformVoltageShiftMv, 4);
    assert.equal(result.perControl.gpuFreqOffsetMhz.ok, true);
    assert.equal(result.perControl.gpuVoltOffsetV.ok, true);
    assert.deepEqual(writes, ['vf']);
    assert.deepEqual(scalarWrites, ['frequency', 'voltage']);
    assert.deepEqual(canonical(live), stockCanonical.map((point) => ({
      ...point,
      voltageV: point.voltageV + 0.004,
    })));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('B580 STOCK profile permits offsets after a uniform 125 mV LIVE shift', async () => {
  const { backend, writes, scalarWrites } = fixture({ writeTransform: (points) => points.map((point) => ({ ...point, Voltage: point.Voltage + 125 })) });
  const result = await backend.applySettings(0, { vfCurve: stockCanonical, gpuFreqOffsetMhz: 10, gpuVoltOffsetV: 5 }, { profileApply: true });
  assert.equal(result.ok, true); assert.equal(result.perControl.vfCurve.uniformVoltageShiftMv, 125);
  assert.deepEqual(writes, ['vf']); assert.deepEqual(scalarWrites, ['frequency', 'voltage']);
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
  assert.equal(result.perControl.vfCurve.errorCode, 'driver-invalid-readback');
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
