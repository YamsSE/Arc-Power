import { physicalTargetOf } from './gpu-inventory.js';
import { clampAndSnap } from './backend/units.js';

const integer = (value) => Number.isInteger(value) && value >= 0;

function stateOf(frameLimit) {
  if (!frameLimit || typeof frameLimit !== 'object'
    || typeof frameLimit.enabled !== 'boolean'
    || !Number.isInteger(frameLimit.value) || frameLimit.value < 0) return null;
  return {
    limit: frameLimit.value,
    denominator: 1,
    limiterEnabled: frameLimit.enabled,
  };
}

function sameState(left, right) {
  return left?.limit === right?.limit
    && left?.denominator === right?.denominator
    && left?.limiterEnabled === right?.limiterEnabled;
}

/**
 * Identity-bound IGCL adapter used by Arc Sleep. IGCL's empty application
 * name applies to the selected adapter's global 3D profile, so the durable
 * device key is required on every read and write. Writes always cross the
 * isolated graphics worker boundary.
 */
export function createArcSleepIGCLLimiter({ backend, store, applyRunner, isElevated } = {}) {
  const selectedTarget = async (expectedDeviceKey = null) => {
    if (typeof backend?.listDevices !== 'function'
      || typeof backend?.getDeviceTarget !== 'function'
      || typeof store?.loadSettings !== 'function') return null;
    const [settings, devices] = await Promise.all([store.loadSettings(), backend.listDevices()]);
    const storedKey = typeof expectedDeviceKey === 'string' && expectedDeviceKey.length > 0
      ? expectedDeviceKey
      : typeof settings?.deviceKey === 'string' && settings.deviceKey.length > 0
        ? settings.deviceKey
        : null;
    if (!storedKey) return null;
    const matches = (Array.isArray(devices) ? devices : [])
      .filter((device) => device?.deviceKey === storedKey);
    if (matches.length !== 1) return null;
    const device = matches[0];
    if (!integer(device.id) || device.identityAmbiguous === true
      || device.synthetic === true || device.backendKind === 'os') return null;
    const physicalTarget = physicalTargetOf(device);
    const hasDurableProof = [
      physicalTarget.pnpDeviceId,
      physicalTarget.bdf,
      physicalTarget.osLuid,
      physicalTarget.physicalToken,
      physicalTarget.legacyDeviceKey,
    ].some((part) => part !== null && part !== undefined && part !== '');
    if (!hasDurableProof) return null;
    const target = await backend.getDeviceTarget(device.id, storedKey, physicalTarget);
    if (!target || target.synthetic === true || target.identityAmbiguous === true
      || target.deviceKey !== storedKey) return null;
    return {
      deviceId: device.id,
      deviceKey: storedKey,
      name: typeof device.name === 'string' ? device.name : null,
      physicalTarget: physicalTargetOf(target),
    };
  };

  const read = async (expectedDeviceKey = null) => {
    const target = await selectedTarget(expectedDeviceKey);
    if (!target || typeof backend?.getGraphicsSettings !== 'function') {
      return { ok: false, available: false, errorCode: 'unavailable', error: 'The selected Intel GPU could not be resolved by its durable identity.' };
    }
    let state;
    try {
      state = await backend.getGraphicsSettings(target.deviceId);
    } catch (error) {
      return { ok: false, available: false, errorCode: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
    const frameLimit = state?.values?.frameLimit;
    const raw = stateOf(frameLimit);
    if (state?.supported?.frameLimit !== true || !raw) {
      return { ok: false, available: false, errorCode: 'unsupported', error: 'The selected Intel GPU does not expose a readable IGCL frame limit.' };
    }
    return {
      ok: true,
      available: true,
      ...raw,
      source: 'igcl',
      deviceId: target.deviceId,
      deviceKey: target.deviceKey,
      deviceName: target.name,
      physicalTarget: target.physicalTarget,
      frameLimitRange: state.frameLimitRange ?? null,
      liveChange: state.frameLimitLiveChange === true,
      frameLimitEffectiveNow: state.frameLimitLiveChange === true,
    };
  };

  const apply = async ({ deviceKey = null, expectedState = null, state: nextState, automatic = false } = {}) => {
    const target = await selectedTarget(deviceKey);
    if (!target) return { ok: false, unavailable: true, errorCode: 'unavailable', error: 'The selected Intel GPU identity is unavailable or ambiguous.' };
    const before = await read(target.deviceKey);
    if (!before.ok) return { ok: false, unavailable: before.available === false, errorCode: before.errorCode, error: before.error };
    if (expectedState && !sameState(before, expectedState)) {
      return { ok: false, conflict: true, errorCode: 'external-change', error: 'The IGCL frame limit changed outside Arc Power.' };
    }
    if (automatic && (typeof isElevated !== 'function' || isElevated() !== true)) {
      return { ok: false, unavailable: true, errorCode: 'elevation-required', error: 'Automatic IGCL frame-limit changes are paused while Arc Power is not elevated.' };
    }
    if (!nextState || typeof nextState.limiterEnabled !== 'boolean'
      || !Number.isInteger(nextState.limit) || nextState.limit < 0) {
      return { ok: false, errorCode: 'invalid-argument', error: 'The requested IGCL frame-limit state is invalid.' };
    }
    if (typeof applyRunner?.graphicsApplyIsolated !== 'function') {
      return { ok: false, unavailable: true, errorCode: 'unavailable', error: 'The isolated IGCL graphics worker is unavailable.' };
    }
    let output;
    try {
      output = await applyRunner.graphicsApplyIsolated({
        deviceId: target.deviceId,
        deviceKey: target.deviceKey,
        physicalTarget: target.physicalTarget,
        settings: { frameLimit: { enabled: nextState.limiterEnabled, value: nextState.limit } },
      });
    } catch (error) {
      return { ok: false, unavailable: false, errorCode: 'io-failed', error: error instanceof Error ? error.message : String(error) };
    }
    const control = output?.perControl?.frameLimit;
    if (output?.ok !== true || control?.ok !== true) {
      return { ok: false, errorCode: control?.errorCode ?? 'io-failed', error: control?.message ?? 'The IGCL frame-limit write was refused.' };
    }
    // IGCL has no compare-and-swap parameter. The pre-read guards ordinary
    // external changes, and this post-read verifies the resulting value; a
    // concurrent third-party writer between read and set cannot be excluded.
    const observed = await read(target.deviceKey);
    if (!observed.ok) return { ok: false, unavailable: true, errorCode: observed.errorCode, error: observed.error, observed };
    if (!sameState(observed, nextState)) {
      return { ok: false, errorCode: 'readback-mismatch', error: 'IGCL frame-limit read-back did not match the requested state.', observed };
    }
    return { ok: true, used: true, source: 'igcl', observedState: observed, route: target };
  };

  return {
    getSelectedTarget: selectedTarget,
    getFrameLimit: read,
    async applyFrameLimit({ enabled, value, expectedState, deviceKey = null, automatic = false } = {}) {
      const current = await read(deviceKey);
      if (!current.ok) return current;
      const range = current.frameLimitRange;
      const snapped = range
        ? clampAndSnap(value, range)
        : Math.max(1, Math.min(1000, Math.round(value)));
      return apply({
        deviceKey: current.deviceKey,
        expectedState,
        state: { limit: snapped, denominator: 1, limiterEnabled: enabled === true },
        automatic,
      });
    },
    async restoreFrameLimitState({ expectedState, state: targetState, deviceKey = null, automatic = false } = {}) {
      const current = await read(deviceKey);
      if (!current.ok) return current;
      if (!targetState || typeof targetState.limiterEnabled !== 'boolean'
        || !Number.isInteger(targetState.limit) || targetState.limit < 0) {
        return { ok: false, errorCode: 'invalid-argument', error: 'The saved IGCL frame-limit state is invalid.' };
      }
      const range = current.frameLimitRange;
      const limit = range
        ? clampAndSnap(targetState.limit, range)
        : Math.max(1, Math.min(1000, Math.round(targetState.limit)));
      const result = await apply({
        deviceKey: current.deviceKey,
        expectedState,
        state: { ...targetState, limit },
        automatic,
      });
      return result.ok
        ? { ...result, observedState: result.observedState }
        : result;
    },
  };
}
