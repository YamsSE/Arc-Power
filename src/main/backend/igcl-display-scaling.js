import { CTL_RESULT, describeResult, encodeScalingSettings, decodeScalingSettings } from './igcl-bindings.js';

const SCALING_FLAGS = new Set([1, 2, 4, 8, 16]);
const VERSION_RETRY = new Set([CTL_RESULT.ERROR_INVALID_ARGUMENT, CTL_RESULT.ERROR_UNSUPPORTED_VERSION]);

function failure(result, operation) {
  return { ok: false, result, error: `${operation} failed: ${describeResult(result)}` };
}

function nativeCall(lib, method, handle, settings) {
  if (typeof lib?.[method] !== 'function' || lib[method].unavailable) return { result: CTL_RESULT.ERROR_UNSUPPORTED_FEATURE };
  try {
    return { result: lib[method](handle, settings.buf) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function getAtVersion(lib, handle, version) {
  try {
  const request = encodeScalingSettings({ version });
  const call = nativeCall(lib, 'ctlGetCurrentScaling', handle, request);
  if (call.error) return { error: call.error, version };
  return call.result === CTL_RESULT.SUCCESS
    ? { result: call.result, version, settings: decodeScalingSettings(request.buf) }
    : { result: call.result, version };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), version };
  }
}

export function readDisplayScaling(lib, handle) {
  if (!handle) return failure(CTL_RESULT.ERROR_INVALID_NULL_HANDLE, 'IGCL scaling GET');
  const v1 = getAtVersion(lib, handle, 1);
  if (v1.error || v1.result === CTL_RESULT.SUCCESS || !VERSION_RETRY.has(v1.result)) return { ...v1, ok: !v1.error && v1.result === CTL_RESULT.SUCCESS };
  const v0 = getAtVersion(lib, handle, 0);
  return { ...v0, ok: !v0.error && v0.result === CTL_RESULT.SUCCESS };
}

function activeProof(settings, flag, custom) {
  if (settings?.enable !== true || settings.scalingType !== flag) return false;
  return flag !== 16 || (settings.customX === custom.x && settings.customY === custom.y);
}

function validCustom(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100;
}

function selectedState(settings, version) {
  if (settings.scalingType === 16) return { flag: 16, custom: { x: settings.customX, y: settings.customY } };
  if (version === 1 && settings.scalingType === 1 && SCALING_FLAGS.has(settings.preferredScalingType)) return { flag: settings.preferredScalingType };
  return { flag: settings.scalingType };
}

async function rollbackOriginal(lib, handle, before, options) {
  const original = selectedState(before.settings, before.version);
  const rollbackSet = await writeWithFallback(lib, handle, original.flag, original.custom, {
    ...options, enable: before.settings.enable, hardwareModeSet: original.flag === 16,
  });
  let rollbackRead;
  if (rollbackSet.result === CTL_RESULT.SUCCESS) {
    try { rollbackRead = readDisplayScaling(lib, handle); }
    catch (error) { rollbackRead = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  const rollbackEqual = rollbackSet.result === CTL_RESULT.SUCCESS && rollbackRead?.ok
    && rollbackRead.settings.enable === before.settings.enable
    && rollbackRead.settings.scalingType === before.settings.scalingType
    && (before.settings.scalingType !== 16
      || (rollbackRead.settings.customX === before.settings.customX && rollbackRead.settings.customY === before.settings.customY))
    && (before.version !== 1 || (rollbackRead.version === 1
      && rollbackRead.settings.preferredScalingType === before.settings.preferredScalingType));
  return { set: rollbackSet, readBack: rollbackRead, readBackEqual: Boolean(rollbackEqual), verified: Boolean(rollbackEqual) };
}

function buildRequest(flag, custom, version, options) {
  return encodeScalingSettings({
    version, enable: options.enable ?? true, scalingType: flag,
    ...(flag === 16 ? { customScalingX: custom.x, customScalingY: custom.y } : {}),
    hardwareModeSet: options.hardwareModeSet ?? flag === 16,
  });
}

function issueSet(lib, handle, flag, custom, version, options) {
  const request = buildRequest(flag, custom, version, options);
  const call = nativeCall(lib, 'ctlSetCurrentScaling', handle, request);
  return { ...call, version };
}

async function settle(options) {
  if (typeof options.settle === 'function') await options.settle();
}

async function writeWithFallback(lib, handle, flag, custom, options) {
  let write = issueSet(lib, handle, flag, custom, 1, options);
  if (!write.error && VERSION_RETRY.has(write.result)) write = issueSet(lib, handle, flag, custom, 0, options);
  if (write.result === CTL_RESULT.SUCCESS) await settle(options);
  return write;
}

export async function applyDisplayScaling(lib, handle, { flag, custom, hardwareModeSet, settle: settleOption } = {}) {
  const options = { settle: settleOption, hardwareModeSet };
  if (!handle) return failure(CTL_RESULT.ERROR_INVALID_NULL_HANDLE, 'IGCL scaling SET');
  if (!SCALING_FLAGS.has(flag)) return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, error: 'Scaling flag must be one of 1, 2, 4, 8, or 16' };
  if (hardwareModeSet !== undefined && typeof hardwareModeSet !== 'boolean') return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, error: 'hardwareModeSet must be boolean' };
  const before = readDisplayScaling(lib, handle);
  if (!before.ok) return { ok: false, result: before.result, error: before.error ?? `Unable to capture original scaling: ${describeResult(before.result)}`, read: before };
  if (!SCALING_FLAGS.has(selectedState(before.settings, before.version).flag)
    || (before.settings.scalingType === 16 && !validCustom(before.settings.customX, before.settings.customY))) {
    return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, error: 'The original scaling state cannot be restored safely.' };
  }

  let targetCustom;
  if (flag === 16) {
    targetCustom = custom === undefined
      ? (before.settings.scalingType === 16 && validCustom(before.settings.customX, before.settings.customY)
        && before.settings.customX > 0 && before.settings.customY > 0
        ? { x: before.settings.customX, y: before.settings.customY }
        : { x: 100, y: 100 })
      : { x: custom?.x, y: custom?.y };
    if (!validCustom(targetCustom.x, targetCustom.y)) return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, error: 'Custom scaling x and y must be integers from 0 to 100' };
  } else if (custom !== undefined) {
    return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, error: 'Custom scaling coordinates are valid only for flag 16' };
  }

  const needsCustomInitialization = flag === 16
    && (before.settings.scalingType !== 16 || !validCustom(before.settings.customX, before.settings.customY)
      || before.settings.customX === 0 || before.settings.customY === 0);
  const isNeutral = targetCustom?.x === 100 && targetCustom?.y === 100;
  let initializedCustom = false;
  let initialization;
  if (needsCustomInitialization && !isNeutral) {
    const neutral = { x: 100, y: 100 };
    const initialize = await writeWithFallback(lib, handle, 16, neutral, { ...options, hardwareModeSet: true });
    if (initialize.error || initialize.result !== CTL_RESULT.SUCCESS) {
      return {
        ok: false, result: initialize.result, error: initialize.error
          ? `IGCL custom scaling initialization SET threw: ${initialize.error}`
          : `IGCL custom scaling initialization SET failed: ${describeResult(initialize.result)}`,
        before, initialization: { set: initialize, readBack: null, readBackEqual: false }, changed: false,
      };
    }
    let initialized;
    try { initialized = readDisplayScaling(lib, handle); }
    catch (error) { initialized = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    const initializedEqual = initialized.ok && activeProof(initialized.settings, 16, neutral);
    initialization = { set: initialize, readBack: initialized, readBackEqual: Boolean(initializedEqual) };
    if (!initializedEqual) {
      const rollback = await rollbackOriginal(lib, handle, before, options);
      return {
        ok: false, result: initialized.result, error: initialized.error ?? 'IGCL neutral custom scaling initialization did not verify',
        before, initialization, rollback,
        readBack: initialized, readBackEqual: false, preferredReadBackEqual: false, deferred: false, verification: 'unverified',
      };
    }
    initializedCustom = true;
  }

  const set = await writeWithFallback(lib, handle, flag, targetCustom, options);
  if (set.error || set.result !== CTL_RESULT.SUCCESS) {
    const error = set.error ? `IGCL scaling SET threw: ${set.error}` : `IGCL scaling SET failed: ${describeResult(set.result)}`;
    const failed = { ok: false, result: set.result, error, set, before, changed: initializedCustom };
    if (initializedCustom) {
      failed.initialization = initialization;
      failed.rollback = await rollbackOriginal(lib, handle, before, options);
    }
    return failed;
  }

  let after;
  try { after = readDisplayScaling(lib, handle); }
  catch (error) { after = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  const settings = after.ok ? after.settings : null;
  const activeEqual = activeProof(settings, flag, targetCustom);
  const preferredEqual = after.version === 1 && flag !== 16 && settings?.enable === true && settings.preferredScalingType === flag;
  const deferred = after.version === 1 && !activeEqual && (flag === 2 || flag === 4 || flag === 8)
    && settings?.enable === true && settings.scalingType === 1 && settings.preferredScalingType === flag;
  const verified = activeEqual || deferred;
  const result = {
    ok: verified, result: set.result, set, before, readBack: after,
    ...(initialization ? { initialization } : {}),
    readBackEqual: activeEqual, preferredReadBackEqual: preferredEqual,
    deferred, verification: activeEqual ? 'native-active' : deferred ? 'native-preference' : 'unverified',
    error: verified ? undefined : after.error ?? `IGCL scaling read-back did not verify flag ${flag}`,
  };
  if (verified) return result;

  return {
    ...result,
    rollback: await rollbackOriginal(lib, handle, before, options),
  };
}
