import { randomBytes } from 'node:crypto';
import { currentBrokerApplyTransactionSequence, withBrokerApplyTransaction } from './apply-lock.js';
import {
  markTemperatureRefusalCacheUnavailable,
  recordApplyRefusalsSafely,
  temperatureRefusalCacheGeneration,
  temperatureRefusalCacheFailure,
} from './apply-refusal-cache-state.js';

export const NATIVE_TEMPERATURE_APPLY_LEASE_BEGIN = '__native-temperature-apply-lease:begin';
export const NATIVE_TEMPERATURE_APPLY_LEASE_FINISH = '__native-temperature-apply-lease:finish';
export const NATIVE_TEMPERATURE_APPLY_LEASE_CANCEL = '__native-temperature-apply-lease:cancel';

const LEASE_CHANNELS = Object.freeze([
  NATIVE_TEMPERATURE_APPLY_LEASE_BEGIN,
  NATIVE_TEMPERATURE_APPLY_LEASE_FINISH,
  NATIVE_TEMPERATURE_APPLY_LEASE_CANCEL,
]);
const CANONICAL_DEVICE_KEY = /^pci:0x[0-9a-f]{8}:0x[0-9a-f]{8}@[0-9]+:[0-9]+\.[0-9]+$/;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validTemperatureRange(range) {
  if (!plainRecord(range) || range.units !== 'C') return false;
  const { min, max, step } = range;
  return Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(step)
    && max >= min && step > 0;
}

function onTemperatureGrid(value, range) {
  if (!Number.isFinite(value) || value < range.min || value > range.max) return false;
  const index = (value - range.min) / range.step;
  return Number.isFinite(index)
    && Math.abs(index - Math.round(index)) <= Number.EPSILON * 256 * Math.max(1, Math.abs(index));
}

function validateBeginPayload(payload) {
  if (!plainRecord(payload)
    || !Number.isSafeInteger(payload.deviceId) || payload.deviceId < 0
    || typeof payload.deviceKey !== 'string' || !CANONICAL_DEVICE_KEY.test(payload.deviceKey)
    || !plainRecord(payload.physicalTarget)
    || (payload.requestId !== undefined && (typeof payload.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.requestId)))
    || (payload.requestedSettings !== undefined && (!plainRecord(payload.requestedSettings)
      || Object.keys(payload.requestedSettings).length !== 1
      || !Number.isFinite(payload.requestedSettings.tempLimitC)))) {
    throw new TypeError('Native temperature lease requires a canonical GPU key and physical proof');
  }
}

function validateFinishPayload(payload) {
  if (!plainRecord(payload) || typeof payload.leaseId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.leaseId)
    || !['completed', 'not-applied'].includes(payload.outcome)
    || (payload.outcome === 'not-applied' && payload.attemptedValue !== undefined)
    || (payload.attemptedValue !== undefined && !Number.isFinite(payload.attemptedValue))
    || !plainRecord(payload.result)
    || typeof payload.result.ok !== 'boolean'
    || !plainRecord(payload.result.perControl)
    || Object.keys(payload.result.perControl).length !== 1
    || !plainRecord(payload.result.perControl.tempLimitC)
    || typeof payload.result.perControl.tempLimitC.ok !== 'boolean'
    || payload.result.ok !== payload.result.perControl.tempLimitC.ok
    || (payload.result.perControl.tempLimitC.ok === false
      && typeof payload.result.perControl.tempLimitC.errorCode !== 'string')) {
    throw new TypeError('Native temperature lease finish payload is invalid');
  }
  const tempResult = payload.result.perControl.tempLimitC;
  if (payload.attemptedValue === undefined
    && tempResult.ok === false && tempResult.errorCode === 'out-of-range'
    && !Number.isFinite(tempResult.capabilityCeiling)) {
    throw new TypeError('Driver temperature refusal has no attempted setter value');
  }
}

/**
 * Hold the existing Electron apply FIFO across a native direct-temperature
 * transaction. The native host receives only a fresh, identity-bound cache
 * snapshot and must return its actual attempted value and per-control result
 * before the lease is released.
 */
export function createNativeTemperatureApplyLease({
  backend,
  isElevated = () => false,
  mockMode = false,
  withTransaction = withBrokerApplyTransaction,
  createLeaseId = () => randomBytes(32).toString('hex'),
  createEpoch = () => randomBytes(16).toString('hex'),
  onUnknown = (target, reason) => markTemperatureRefusalCacheUnavailable(backend,
    `native temperature apply outcome is unknown for ${target?.deviceKey ?? 'unknown target'}: ${reason}`),
} = {}) {
  if (!backend || typeof backend !== 'object' || typeof withTransaction !== 'function') {
    throw new TypeError('Native temperature apply lease requires a backend and broker transaction');
  }
  const leases = new Map();
  const cancelledRequests = new Set();
  const pendingRequestIds = new Set();
  const cacheGenerations = new Map();
  const cacheFingerprints = new Map();
  const epoch = createEpoch();
  if (typeof epoch !== 'string' || !/^[a-f0-9]{32}$/.test(epoch)) {
    throw new TypeError('Native temperature apply lease requires a valid broker epoch');
  }
  let closed = false;

  async function prepare(payload) {
    validateBeginPayload(payload);
    if (mockMode || isElevated() !== true) throw new Error('Native temperature apply lease is unavailable in this host mode');
    if (temperatureRefusalCacheFailure(backend)) throw new Error('The temperature refusal cache is unavailable; native apply is blocked');
    if (typeof backend.getDeviceTarget !== 'function' || typeof backend.assertDeviceTarget !== 'function'
      || typeof backend.getCapabilities !== 'function') {
      throw new Error('Fresh native temperature apply preflight is unavailable');
    }

    await backend.assertDeviceTarget(payload.deviceId, payload.deviceKey, payload.physicalTarget);
    const target = await backend.getDeviceTarget(payload.deviceId, payload.deviceKey, payload.physicalTarget);
    if (!target || target.deviceKey !== payload.deviceKey) throw new Error('Native temperature apply target identity changed');
    const caps = await backend.getCapabilities(payload.deviceId);
    if (!caps || caps.deviceKey !== payload.deviceKey || !validTemperatureRange(caps.ranges?.tempLimitC)
      || caps.refusalCacheIdentity?.status === 'unavailable') {
      throw new Error('Fresh native temperature range or refusal cache is unavailable');
    }
    if (temperatureRefusalCacheFailure(backend)) throw new Error('The temperature refusal cache became unavailable during preflight');
    await backend.assertDeviceTarget(payload.deviceId, payload.deviceKey, payload.physicalTarget);
    const range = caps.ranges.tempLimitC;
    const learnedCeiling = caps.learnedCeilings?.tempLimitC;
    if (learnedCeiling !== undefined
      && (!Number.isFinite(learnedCeiling) || !onTemperatureGrid(learnedCeiling, range))) {
      throw new Error('Fresh temperature refusal ceiling is invalid');
    }
    const fingerprint = learnedCeiling === undefined ? 'none' : String(learnedCeiling);
    const previousFingerprint = cacheFingerprints.get(payload.deviceKey);
    const suppliedGeneration = temperatureRefusalCacheGeneration(backend);
    const nativeGeneration = caps.refusalCacheGeneration;
    const hasNativeGeneration = Number.isSafeInteger(nativeGeneration) && nativeGeneration >= 0;
    let generation = hasNativeGeneration
      ? nativeGeneration
      : Math.max(cacheGenerations.get(payload.deviceKey) ?? 0, suppliedGeneration);
    if (!hasNativeGeneration && previousFingerprint !== undefined && previousFingerprint !== fingerprint && generation < Number.MAX_SAFE_INTEGER) {
      generation += 1;
    }
    cacheFingerprints.set(payload.deviceKey, fingerprint);
    cacheGenerations.set(payload.deviceKey, generation);
    const transactionSequence = currentBrokerApplyTransactionSequence();
    if (!Number.isSafeInteger(transactionSequence) || transactionSequence <= 0) {
      throw new Error('Native temperature lease did not acquire the broker apply FIFO');
    }
    const brokerTarget = { ...structuredClone(target), electronOrdinal: payload.deviceId };
    return {
      deviceId: payload.deviceId,
      deviceKey: payload.deviceKey,
      requestId: payload.requestId,
      physicalTarget: structuredClone(payload.physicalTarget),
      snapshot: {
        type: 'temperature-refusal-cache:begin',
        schemaVersion: 1,
        epoch,
        transactionSequence,
        cacheGeneration: generation,
        target: brokerTarget,
        ranges: { tempLimitC: structuredClone(range) },
        requestedSettings: structuredClone(payload.requestedSettings ?? {}),
        cache: {
          status: 'available',
          ceilings: { tempLimitC: learnedCeiling },
        },
        ocMode: caps.ocMode ?? null,
        extendedControls: structuredClone(caps.extendedControls ?? {}),
      },
    };
  }

  async function publish(entry, payload) {
    const attemptedSettings = { tempLimitC: payload.attemptedValue };
    const range = entry.snapshot.ranges.tempLimitC;
    if (Number.isFinite(payload.attemptedValue) && !onTemperatureGrid(payload.attemptedValue, range)) {
      throw new Error('Native temperature lease returned an attempted value outside its fresh range');
    }
    const envelope = { result: payload.result };
    const refused = payload.result.perControl.tempLimitC.ok === false
      && payload.result.perControl.tempLimitC.errorCode === 'out-of-range';
    let publication = 'not-required';
    let learnedCeiling = entry.snapshot.cache.ceilings.tempLimitC;
    if (Number.isFinite(payload.attemptedValue)) {
      publication = await recordApplyRefusalsSafely(backend, entry.deviceId, envelope, attemptedSettings, {
        ranges: entry.snapshot.ranges,
        deviceKey: entry.deviceKey,
        physicalTarget: entry.physicalTarget,
      });
      if (refused && publication === 'committed') {
        const explicitCeiling = payload.result.perControl.tempLimitC.capabilityCeiling;
        const candidate = Number.isFinite(explicitCeiling)
          ? explicitCeiling
          : Math.round((payload.attemptedValue - range.step) * 1e9) / 1e9;
        if (Number.isFinite(candidate) && onTemperatureGrid(candidate, range)) {
          learnedCeiling = learnedCeiling === undefined ? candidate : Math.min(learnedCeiling, candidate);
        }
      }
    }
    if (refused && Number.isFinite(payload.attemptedValue) && publication !== 'committed') {
      throw new Error('Native temperature refusal was not published to the broker cache');
    }
    if (publication === 'unavailable' || temperatureRefusalCacheFailure(backend)) {
      throw new Error('The temperature refusal cache is unavailable after native apply');
    }
    const cacheGeneration = temperatureRefusalCacheGeneration(backend);
    const nativeCacheGeneration = entry.snapshot.cacheGeneration;
    cacheGenerations.set(entry.deviceKey, Number.isSafeInteger(nativeCacheGeneration)
      ? Math.max(cacheGeneration, nativeCacheGeneration)
      : Math.max(cacheGeneration, cacheGenerations.get(entry.deviceKey) ?? 0));
    cacheFingerprints.set(entry.deviceKey, learnedCeiling === undefined ? 'none' : String(learnedCeiling));
    return {
      leaseId: entry.leaseId,
      result: structuredClone(payload.result),
      snapshot: {
        type: 'temperature-refusal-cache:finish',
        schemaVersion: 1,
        epoch,
        transactionSequence: entry.snapshot.transactionSequence,
        cacheGeneration: cacheGenerations.get(entry.deviceKey),
        target: structuredClone(entry.snapshot.target),
        publication,
        attemptedSettings,
        ranges: structuredClone(entry.snapshot.ranges),
        perControl: structuredClone(payload.result.perControl),
        cache: {
          status: 'available',
          ceilings: { tempLimitC: learnedCeiling },
        },
      },
    };
  }

  function begin(payload) {
    if (closed) return Promise.reject(new Error('Native temperature lease service is closed'));
    try { validateBeginPayload(payload); } catch (error) { return Promise.reject(error); }
    const requestId = payload.requestId ?? randomBytes(16).toString('hex');
    if (cancelledRequests.has(requestId)) {
      cancelledRequests.delete(requestId);
      return Promise.reject(new Error('Native temperature lease begin was cancelled'));
    }
    const normalizedPayload = { ...payload, requestId };
    pendingRequestIds.add(requestId);
    const activated = deferred();
    let entry = null;
    const finishOutcome = deferred();
    const completed = deferred();
    const transaction = withTransaction(async () => {
      if (closed) throw new Error('Native temperature lease service is closed');
      const prepared = await prepare(normalizedPayload);
      if (closed) throw new Error('Native temperature lease service is closed');
      if (cancelledRequests.has(requestId)) {
        cancelledRequests.delete(requestId);
        throw new Error('Native temperature lease begin was cancelled');
      }
      const leaseId = createLeaseId();
      if (typeof leaseId !== 'string' || !/^[a-f0-9]{64}$/.test(leaseId) || leases.has(leaseId)) {
        throw new Error('Could not allocate a unique native temperature lease');
      }
      entry = { ...prepared, leaseId, requestId, finishOutcome, completed, state: 'active' };
      leases.set(leaseId, entry);
      activated.resolve({ leaseId, requestId, snapshot: structuredClone(entry.snapshot) });
      const outcome = await finishOutcome.promise;
      if (outcome.kind === 'unknown') {
        throw new Error('Native temperature apply outcome is unknown; refresh before another apply');
      }
      if (outcome.kind === 'cancelled') return { leaseId, cancelled: true };
      try {
        return await publish(entry, outcome.payload);
      } catch (error) {
        // This catch is inside the broker transaction body. A refusal that
        // cannot be published must poison Rust before the FIFO turn releases.
        entry.state = 'unknown';
        try {
          await onUnknown(entry.snapshot.target, error instanceof Error ? error.message : String(error));
        } catch (poisonError) {
          throw new AggregateError([error, poisonError], 'Native temperature apply failed and cache poison was not acknowledged.');
        }
        throw error;
      }
    }, { label: 'native-temperature-apply-lease' });
    void transaction.then(
      (result) => {
        pendingRequestIds.delete(requestId);
        if (entry) {
          entry.state = 'finished';
          entry.completed.resolve(result);
          leases.delete(entry.leaseId);
        }
      },
      async (error) => {
        pendingRequestIds.delete(requestId);
        cancelledRequests.delete(requestId);
        if (!entry) activated.reject(error);
        else {
          if (entry.state !== 'unknown') {
            try { await onUnknown(entry.snapshot.target, error instanceof Error ? error.message : String(error)); }
            catch { /* fail closed during transaction teardown */ }
          }
          entry.state = 'failed';
          entry.completed.reject(error);
          leases.delete(entry.leaseId);
        }
      },
    );
    return activated.promise;
  }

  async function finish(payload) {
    if (!plainRecord(payload) || typeof payload.leaseId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.leaseId)) {
      throw new TypeError('Native temperature lease finish payload is invalid');
    }
    const entry = leases.get(payload.leaseId);
    if (!entry || entry.state !== 'active') throw new Error('Native temperature lease is missing or already finished');
    if (closed) throw new Error('Native temperature lease service is closed');
    if (payload.outcome === 'unknown') {
      entry.state = 'unknown';
      try { await onUnknown(entry.snapshot.target, typeof payload.reason === 'string' ? payload.reason : 'native apply outcome is unknown'); }
      catch { /* fail closed during transaction teardown */ }
      entry.finishOutcome.resolve({ kind: 'unknown', reason: payload.reason ?? 'native apply outcome is unknown' });
      await entry.completed.promise.catch(() => {});
      throw new Error('Native temperature apply outcome is unknown; refresh before another apply');
    }
    try {
      validateFinishPayload(payload);
    } catch (error) {
      entry.state = 'unknown';
      try { await onUnknown(entry.snapshot.target, error instanceof Error ? error.message : String(error)); }
      catch { /* fail closed during transaction teardown */ }
      entry.finishOutcome.resolve({ kind: 'unknown', reason: 'malformed native result' });
      await entry.completed.promise.catch(() => {});
      throw error;
    }
    entry.state = 'finishing';
    entry.finishOutcome.resolve({ kind: 'completed', payload: structuredClone(payload) });
    return await entry.completed.promise;
  }

  async function cancel(payload) {
    if (!plainRecord(payload) || typeof payload.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.requestId)) {
      throw new TypeError('Native temperature lease cancellation is invalid');
    }
    if (closed) throw new Error('Native temperature lease service is closed');
    const entry = [...leases.values()].find((candidate) => candidate.requestId === payload.requestId);
    if (!pendingRequestIds.has(payload.requestId) && !entry) {
      return { requestId: payload.requestId, cancelled: true, leaseReleased: false };
    }
    cancelledRequests.add(payload.requestId);
    if (entry?.state === 'active') {
      entry.state = 'cancelled';
      entry.finishOutcome.resolve({ kind: 'cancelled' });
      await entry.completed.promise;
      return { requestId: payload.requestId, cancelled: true, leaseReleased: true };
    }
    return { requestId: payload.requestId, cancelled: true, leaseReleased: false };
  }

  function close(reason = 'broker disconnected') {
    if (closed) return;
    closed = true;
    for (const entry of leases.values()) {
      if (entry.state === 'unknown' || entry.state === 'failed' || entry.state === 'finished') continue;
      const wasActive = entry.state === 'active';
      if (wasActive) entry.state = 'unknown';
      try { void Promise.resolve(onUnknown(entry.snapshot.target, reason)).catch(() => {}); }
      catch { /* poison is best effort only during teardown */ }
      if (wasActive) entry.finishOutcome.resolve({ kind: 'unknown', reason });
    }
  }

  return {
    begin,
    finish,
    cancel,
    close,
    get activeLeaseCount() { return leases.size; },
  };
}

export { LEASE_CHANNELS as NATIVE_TEMPERATURE_APPLY_LEASE_CHANNELS };
