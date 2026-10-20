// Disposable RUN-AS-NODE process for the 3D sharpening feature. It owns at
// most one IGCL context and exits after one request so legacy DLL state can
// never overlap the long-lived overclock runtime.
import koffi from 'koffi';
import { CTL_3D_FEATURE, CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_INIT_FLAG_IGSC_FUL,
  CTL_PROPERTY_VALUE_TYPE, CTL_RESULT, decode3dFeatureDetails,
  decode3dFeatureGetsetValue, describeResult, encode3dFeatureGetset,
  findIgclDll, loadIgcl, makeVersion } from './backend/igcl-bindings.js';
import { oldIgclDllPath } from './old-igcl.js';
import { sharpeningGuardIsLive, validateSharpeningRequest } from './sharpening-contract.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ZERO_UID = { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] };

function physicalLuid(handle, lib, version) {
  const luid = koffi.alloc('uint8', 8);
  for (let i = 0; i < 8; i += 1) koffi.encode(luid, i, 'uint8', 0);
  const props = koffi.alloc('ctl_device_adapter_properties_t', 1);
  koffi.encode(props, 'ctl_device_adapter_properties_t', {
    Size: koffi.sizeof('ctl_device_adapter_properties_t'), Version: version,
    pDeviceID: koffi.address(luid), device_id_size: 8,
  });
  const result = lib.ctlGetDeviceProperties(handle, props);
  if (result !== CTL_RESULT.SUCCESS) return null;
  if (Number(koffi.decode(props, koffi.offsetof('ctl_device_adapter_properties_t', 'device_id_size'), 'uint32')) !== 8) return null;
  const bytes = Array.from({ length: 8 }, (_, i) => Number(koffi.decode(luid, i, 'uint8')));
  return bytes.some((value) => value !== 0) ? Buffer.from(bytes).toString('hex') : null;
}

function enumerate(lib, api, requestedLuid, propertyVersion) {
  const count = koffi.alloc('uint32', 1);
  koffi.encode(count, 'uint32', 0);
  let result = lib.ctlEnumerateDevices(api, count, null);
  if (result !== CTL_RESULT.SUCCESS) throw new Error(`device enumeration failed: ${describeResult(result)}`);
  const n = Number(koffi.decode(count, 'uint32'));
  if (n < 1 || n > 64) throw new Error('IGCL returned an invalid adapter count');
  const handles = koffi.alloc('void*', n);
  koffi.encode(count, 'uint32', n);
  result = lib.ctlEnumerateDevices(api, count, handles);
  if (result !== CTL_RESULT.SUCCESS) throw new Error(`device enumeration failed: ${describeResult(result)}`);
  const found = [];
  for (let i = 0; i < n; i += 1) {
    found.push(koffi.decode(handles, i * 8, 'void*'));
  }
  return matchUniqueLuid(found, (handle) => physicalLuid(handle, lib, propertyVersion), requestedLuid);
}

export function validateSharpeningCapability(detail) {
  const range = detail?.intRange;
  return Boolean(detail?.featureType === CTL_3D_FEATURE.SHARPENING_FILTER
    && detail?.valueType === CTL_PROPERTY_VALUE_TYPE.INT32
    && Number.isInteger(range?.min) && Number.isInteger(range?.max)
    && Number.isInteger(range.step) && Number.isInteger(range.default)
    && range.min === 0 && range.max === 100 && range.step === 1
    && range.default >= range.min && range.default <= range.max
    && (range.default - range.min) % range.step === 0);
}

export function matchUniqueLuid(handles, luidOf, expectedLuid) {
  const matches = handles.filter((handle) => luidOf(handle)?.toLowerCase() === expectedLuid.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? 'adapter identity matched more than once' : 'the requested physical adapter was not found by LUID');
  return matches[0];
}

export function resolveLegacySharpeningDllPath(legacyPath) {
  // In RUN_AS_NODE, Electron may not populate resourcesPath. The fallback
  // URL from oldIgclDllPath then points inside app.asar, where native DLLs
  // cannot be loaded. Resolve its mirrored unpacked location instead.
  return legacyPath.replace(/app\.asar(?=[\\/]|$)/i, 'app.asar.unpacked');
}

export function interpretSharpeningRead(result, value, detail) {
  if (result === CTL_RESULT.ERROR_DATA_NOT_FOUND) return { enabled: detail.defaultEnabled === true, percentage: detail.intRange.default, isDefault: true };
  if (result !== CTL_RESULT.SUCCESS) return { error: describeResult(result) };
  if (!Number.isInteger(value?.percentage) || value.percentage < 0 || value.percentage > 100
    || typeof value?.enabled !== 'boolean') return { error: 'driver returned an invalid sharpening value' };
  return { enabled: value.enabled, percentage: value.percentage, isDefault: false };
}

function capabilities(lib, handle) {
  const caps = koffi.alloc('uint8', 24);
  koffi.encode(caps, 0, 'uint32', 24);
  koffi.encode(caps, 4, 'uint8', 0);
  koffi.encode(caps, 8, 'uint32', 0);
  koffi.encode(caps, 16, 'void*', 0n);
  let result = lib.ctlGetSupported3DCapabilities(handle, caps);
  if (result !== CTL_RESULT.SUCCESS) return null;
  const n = Number(koffi.decode(caps, 8, 'uint32'));
  if (!Number.isInteger(n) || n < 1 || n > 256) return null;
  const details = koffi.alloc('uint8', n * koffi.sizeof('ctl_3d_feature_details_t'));
  koffi.encode(caps, 8, 'uint32', n);
  koffi.encode(caps, 16, 'void*', koffi.address(details));
  result = lib.ctlGetSupported3DCapabilities(handle, caps);
  if (result !== CTL_RESULT.SUCCESS) return null;
  for (let i = 0; i < n; i += 1) {
    const detail = decode3dFeatureDetails(details, i);
    if (detail.featureType === CTL_3D_FEATURE.SHARPENING_FILTER) return detail;
  }
  return null;
}

function readValue(lib, handle, detail, applicationName = '') {
  const request = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.SHARPENING_FILTER,
    valueType: CTL_PROPERTY_VALUE_TYPE.INT32, bSet: false, applicationName });
  const result = lib.ctlGetSet3DFeature(handle, request.buf);
  const decoded = result === CTL_RESULT.SUCCESS
    ? decode3dFeatureGetsetValue(request.buf, CTL_PROPERTY_VALUE_TYPE.INT32)
    : null;
  return interpretSharpeningRead(result, decoded && { enabled: decoded.enable === true, percentage: decoded.value }, {
    defaultEnabled: detail.defaultEnabled === true, intRange: detail.intRange });
}

export function sharpeningReadMatchesRequest(read, request, detail) {
  if (!read || read.error || read.enabled !== request.enabled || read.percentage !== request.percentage) return false;
  if (!read.isDefault) return true;
  return read.enabled === (detail.defaultEnabled === true)
    && read.percentage === detail.intRange.default;
}

// The bundled 2023 runtime is only a compatibility fallback when the current
// runtime could not establish a context for the requested physical adapter.
// Once the current runtime matched that adapter, its capability result is
// authoritative; an older DLL must not override an explicit lack of support.
export function shouldTryLegacySharpeningFallback(currentAdapterMatched) {
  return currentAdapterMatched !== true;
}

async function main(request, canContinue) {
  if (!canContinue()) return { ok: false, errorCode: 'cancelled', message: 'The sharpening request expired or its parent disconnected.' };
  const dlls = [{ path: findIgclDll(), legacy: false },
    { path: resolveLegacySharpeningDllPath(oldIgclDllPath()), legacy: true }];
  const failures = [];
  let currentAdapterMatched = false;
  for (const candidate of dlls) {
    if (candidate.legacy && !shouldTryLegacySharpeningFallback(currentAdapterMatched)) break;
    if (!candidate.path) continue;
    let lib;
    let api = null;
    try {
      lib = loadIgcl(candidate.path);
      if (typeof lib.ctlGetSupported3DCapabilities !== 'function' || typeof lib.ctlGetSet3DFeature !== 'function') continue;
      const initArgs = koffi.alloc('ctl_init_args_t', 1);
      const apiBuffer = koffi.alloc('void*', 1);
      koffi.encode(initArgs, 'ctl_init_args_t', {
        Size: candidate.legacy ? 36 : koffi.sizeof('ctl_init_args_t'), Version: 0,
        AppVersion: makeVersion(candidate.legacy ? 1 : 1, candidate.legacy ? 0 : 1),
        flags: CTL_INIT_FLAG_USE_LEVEL_ZERO | CTL_INIT_FLAG_IGSC_FUL,
        SupportedVersion: 0, ApplicationUID: ZERO_UID,
      });
      let initResult = lib.ctlInit(initArgs, apiBuffer);
      if (!candidate.legacy && initResult === CTL_RESULT.ERROR_IGSC_LOADER) {
        koffi.encode(initArgs, 'ctl_init_args_t', {
          Size: koffi.sizeof('ctl_init_args_t'), Version: 0, AppVersion: makeVersion(1, 1),
          flags: CTL_INIT_FLAG_USE_LEVEL_ZERO, SupportedVersion: 0, ApplicationUID: ZERO_UID,
        });
        initResult = lib.ctlInit(initArgs, apiBuffer);
      }
      if (initResult !== CTL_RESULT.SUCCESS) { failures.push(describeResult(initResult)); continue; }
      api = koffi.decode(apiBuffer, 0, 'void*');
      if (!api) throw new Error('IGCL returned a null API handle');
      const handle = enumerate(lib, api, request.luid, candidate.legacy ? 0 : 3);
      if (!candidate.legacy) currentAdapterMatched = true;
      const detail = capabilities(lib, handle);
      if (!validateSharpeningCapability(detail)) {
        failures.push('sharpening is not advertised with an integer 0-100 range');
        continue;
      }
      if (request.applicationName && detail.perAppSupport !== true) {
        failures.push('The current sharpening runtime does not expose per-game settings.');
        continue;
      }
      if (request.action === 'capabilities') return { ok: true, supported: true, range: detail.intRange,
        default: { enabled: detail.defaultEnabled === true, percentage: detail.intRange.default },
        perAppSupport: detail.perAppSupport === true, liveChange: detail.liveChange === true,
        source: candidate.legacy ? 'legacy-igcl-1.0.100' : 'driverstore-igcl' };
      if (request.action === 'read') {
        const value = readValue(lib, handle, detail, request.applicationName ?? '');
        if (value.error) return { ok: false, supported: true, errorCode: 'io-failed', message: `Sharpening read failed: ${value.error}` };
        return { ok: true, supported: true, value, range: detail.intRange, perAppSupport: detail.perAppSupport === true,
          liveChange: detail.liveChange === true, source: candidate.legacy ? 'legacy-igcl-1.0.100' : 'driverstore-igcl' };
      }
      const set = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.SHARPENING_FILTER,
        valueType: CTL_PROPERTY_VALUE_TYPE.INT32, bSet: true, intEnable: request.enabled,
        intValue: request.percentage, applicationName: request.applicationName ?? '' });
      if (!canContinue()) return { ok: false, supported: true, errorCode: 'cancelled', message: 'The sharpening request expired before the write.' };
      const setResult = lib.ctlGetSet3DFeature(handle, set.buf);
      if (setResult !== CTL_RESULT.SUCCESS) return { ok: false, supported: true, errorCode: 'io-failed', message: `Sharpening set failed: ${describeResult(setResult)}` };
      const immediate = readValue(lib, handle, detail, request.applicationName ?? '');
      if (!canContinue()) return { ok: false, supported: true, errorCode: 'timeout', message: 'The sharpening request expired during verification.' };
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!canContinue()) return { ok: false, supported: true, errorCode: 'timeout', message: 'The sharpening request expired before delayed verification completed.' };
      const value = readValue(lib, handle, detail, request.applicationName ?? '');
      const immediateMatched = sharpeningReadMatchesRequest(immediate, request, detail);
      const delayedMatched = sharpeningReadMatchesRequest(value, request, detail);
      const matched = immediateMatched && delayedMatched;
      return { ok: matched, supported: true, value: matched ? value : null, readBackEqual: matched,
        errorCode: matched ? undefined : 'io-failed', message: matched ? undefined : 'Sharpening write did not match both immediate and delayed fresh read-backs.',
        range: detail.intRange, perAppSupport: detail.perAppSupport === true,
        liveChange: detail.liveChange === true, source: candidate.legacy ? 'legacy-igcl-1.0.100' : 'driverstore-igcl' };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      if (api && typeof lib?.ctlClose === 'function') { try { lib.ctlClose(api); } catch { /* isolated process exits */ } }
    }
  }
  return { ok: false, supported: false, errorCode: 'unsupported', message: failures.at(-1) ?? 'No IGCL sharpening runtime is available.' };
}

export async function runSharpeningHelperRequest(request, { execute = main, isConnected = () => true, now = Date.now, guardIsLive = sharpeningGuardIsLive } = {}) {
  if (!validateSharpeningRequest(request, now())) return { ok: false, errorCode: 'invalid-argument', message: 'Invalid sharpening helper request.' };
  const canContinue = () => isConnected() && request.deadlineAt > now()
    && (request.guard === undefined || guardIsLive(request.guard, now()));
  if (!canContinue()) return { ok: false, errorCode: 'cancelled', message: 'The sharpening request expired or its parent disconnected.' };
  return execute(request, canContinue);
}

export function isParentProcessAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let disconnected = false;
  const parentPid = process.ppid;
  process.on('disconnect', () => { disconnected = true; });
  process.once('message', async (request) => {
    let output;
    try {
      output = await runSharpeningHelperRequest(request, {
        // process.connected can remain stale until Node services its IPC
        // disconnect event. The OS process check stays live even while a
        // synchronous native call blocks this helper's event loop.
        isConnected: () => !disconnected && process.connected === true && isParentProcessAlive(parentPid),
      });
    } catch (error) {
      output = { ok: false, errorCode: 'helper-failed', message: error instanceof Error ? error.message : String(error) };
    }
    if (!disconnected && process.connected === true) {
      try { process.send(output, () => process.disconnect()); } catch { process.exit(1); }
    } else process.exit(1);
  });
  process.on('disconnect', () => { if (disconnected) process.exit(1); });
}
