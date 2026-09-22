// Windows display-mode reapply used after an IGCL scaling-preference write.
//
// IGCL stores the requested GPU scaler as a preferred output mode. The
// driver consumes that preference when Windows applies the output mode, so a
// native preference write alone can legitimately leave the active scaler at
// Identity while the desktop is already at the panel's native resolution.
// Reapplying the current DEVMODE asks Windows to perform that mode
// application without changing the user's resolution, refresh rate, or
// registry display profile.

import koffi from 'koffi';

const DISPLAY_DEVICE_SIZE = 840;
const DEVMODE_SIZE = 220;
const ENUM_CURRENT_SETTINGS = 0xffffffff;
const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001;
const CDS_RESET = 0x40000000;
const DISP_CHANGE_SUCCESSFUL = 0;
const DM_PELSWIDTH = 0x00080000;
const DM_PELSHEIGHT = 0x00100000;
const DM_DISPLAYFREQUENCY = 0x00400000;

// DISPLAY_DEVICEW offsets.
const DISPLAY_DEVICE_NAME_OFFSET = 4;
const DISPLAY_DEVICE_NAME_LENGTH = 32;
const DISPLAY_DEVICE_STRING_OFFSET = 68;
const DISPLAY_DEVICE_STRING_LENGTH = 128;
const DISPLAY_DEVICE_STATE_FLAGS_OFFSET = 324;
const DISPLAY_DEVICE_ID_OFFSET = 328;
const DISPLAY_DEVICE_ID_LENGTH = 128;

// DEVMODEW offsets used by EnumDisplaySettingsExW/ChangeDisplaySettingsExW.
const DEVMODE_SIZE_OFFSET = 68;
const DEVMODE_FIELDS_OFFSET = 72;
const DEVMODE_PELS_WIDTH_OFFSET = 172;
const DEVMODE_PELS_HEIGHT_OFFSET = 176;
const DEVMODE_DISPLAY_FREQUENCY_OFFSET = 184;
// dmLogPixels occupies 164..165; dmBitsPerPel is the DWORD at 168 after
// the DEVMODEW alignment padding. Width/height/frequency retain the offsets
// used by the existing reapply path.
const DEVMODE_BITS_PER_PIXEL_OFFSET = 168;
const DEVMODE_DISPLAY_FLAGS_OFFSET = 180;
const DEVMODE_ORIENTATION_OFFSET = 84;
// EnumDisplaySettingsExW's dwFlags is zero for the normal indexed mode list.
// ENUM_REGISTRY_SETTINGS is an iModeNum value (-2), not a flags bit; using 1
// here can make the driver return an incomplete or implementation-specific
// mode list.
const ENUM_MODE_FLAGS = 0;

function readUtf16z(buffer, offset, length) {
  const chars = [];
  for (let index = 0; index < length; index += 1) {
    const codeUnit = Number(koffi.decode(buffer, offset + index * 2, 'uint16'));
    if (codeUnit === 0) break;
    chars.push(codeUnit);
  }
  return String.fromCharCode(...chars);
}

function normalizeDisplayLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function displayLabelMatches(label, candidate) {
  const wanted = normalizeDisplayLabel(label);
  const actual = normalizeDisplayLabel(candidate);
  if (!wanted || !actual || wanted.length < 4) return false;
  return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
}

function readDisplayDevice(buffer) {
  return {
    deviceName: readUtf16z(buffer, DISPLAY_DEVICE_NAME_OFFSET, DISPLAY_DEVICE_NAME_LENGTH),
    deviceString: readUtf16z(buffer, DISPLAY_DEVICE_STRING_OFFSET, DISPLAY_DEVICE_STRING_LENGTH),
    stateFlags: Number(koffi.decode(buffer, DISPLAY_DEVICE_STATE_FLAGS_OFFSET, 'uint32')) >>> 0,
    deviceId: readUtf16z(buffer, DISPLAY_DEVICE_ID_OFFSET, DISPLAY_DEVICE_ID_LENGTH),
  };
}

function readMode(buffer) {
  return {
    width: Number(koffi.decode(buffer, DEVMODE_PELS_WIDTH_OFFSET, 'uint32')),
    height: Number(koffi.decode(buffer, DEVMODE_PELS_HEIGHT_OFFSET, 'uint32')),
    refreshRate: Number(koffi.decode(buffer, DEVMODE_DISPLAY_FREQUENCY_OFFSET, 'uint32')),
    bitsPerPixel: Number(koffi.decode(buffer, DEVMODE_BITS_PER_PIXEL_OFFSET, 'uint32')),
    displayFlags: Number(koffi.decode(buffer, DEVMODE_DISPLAY_FLAGS_OFFSET, 'uint32')) >>> 0,
    orientation: Number(koffi.decode(buffer, DEVMODE_ORIENTATION_OFFSET, 'uint16')),
  };
}

function cloneBuffer(buffer) {
  const copy = koffi.alloc('uint8', DEVMODE_SIZE);
  for (let index = 0; index < DEVMODE_SIZE; index += 1) {
    koffi.encode(copy, index, 'uint8', Number(koffi.decode(buffer, index, 'uint8')));
  }
  return copy;
}

function validDimension(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 32768;
}

function normalizeMode(mode) {
  if (!mode || !validDimension(mode.width) || !validDimension(mode.height)) return null;
  const refreshRate = Number(mode.refreshRate);
  if (!Number.isFinite(refreshRate) || refreshRate <= 0) return null;
  return {
    width: Number(mode.width),
    height: Number(mode.height),
    refreshRate,
    bitsPerPixel: Number(mode.bitsPerPixel) || 0,
    displayFlags: Number(mode.displayFlags) >>> 0,
    orientation: Number(mode.orientation) || 0,
  };
}

function modeKey(mode) {
  return [mode.width, mode.height, mode.refreshRate, mode.bitsPerPixel, mode.displayFlags, mode.orientation].join(':');
}

function outputIdentity(output) {
  const monitorIds = output.monitors
    .map((monitor) => monitor.deviceId)
    .filter((value) => typeof value === 'string' && value.length > 0);
  return monitorIds.length > 0
    ? monitorIds.join('|')
    : (output.adapter.deviceId || output.adapter.deviceName);
}

function modeMatches(mode, expected) {
  if (!expected?.resolution) return false;
  const width = Number(expected.resolution.width);
  const height = Number(expected.resolution.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (mode.width !== width || mode.height !== height) return false;
  if (!Number.isFinite(Number(expected.refreshRate)) || expected.refreshRate <= 0) return true;
  return Math.abs(mode.refreshRate - Number(expected.refreshRate)) <= 1;
}

function makeWin32Api(deps) {
  if (deps.enumDisplayDevices && deps.enumDisplaySettings && deps.changeDisplaySettings) {
    return {
      enumDisplayDevices: deps.enumDisplayDevices,
      enumDisplaySettings: deps.enumDisplaySettings,
      changeDisplaySettings: deps.changeDisplaySettings,
    };
  }
  const user32 = deps.user32 ?? koffi.load('user32.dll');
  return {
    enumDisplayDevices: deps.enumDisplayDevices
      ?? user32.func('EnumDisplayDevicesW', 'bool', ['str16', 'uint32', 'void*', 'uint32']),
    enumDisplaySettings: deps.enumDisplaySettings
      ?? user32.func('EnumDisplaySettingsExW', 'bool', ['str16', 'uint32', 'void*', 'uint32']),
    changeDisplaySettings: deps.changeDisplaySettings
      ?? user32.func('ChangeDisplaySettingsExW', 'int32', ['str16', 'void*', 'void*', 'uint32', 'void*']),
  };
}

function queryDisplayDevice(api, deviceName, index) {
  const buffer = koffi.alloc('uint8', DISPLAY_DEVICE_SIZE);
  koffi.encode(buffer, 0, 'uint32', DISPLAY_DEVICE_SIZE);
  if (!api.enumDisplayDevices(deviceName, index, buffer, 0)) return null;
  return readDisplayDevice(buffer);
}

function queryCurrentMode(api, deviceName) {
  const buffer = koffi.alloc('uint8', DEVMODE_SIZE);
  // EnumDisplaySettingsExW expects dmSize to be initialized by the caller;
  // without it Windows can return TRUE while leaving the mode payload empty.
  koffi.encode(buffer, DEVMODE_SIZE_OFFSET, 'uint16', DEVMODE_SIZE);
  if (!api.enumDisplaySettings(deviceName, ENUM_CURRENT_SETTINGS, buffer, 0)) return null;
  const reportedSize = Number(koffi.decode(buffer, DEVMODE_SIZE_OFFSET, 'uint16'));
  if (reportedSize < DEVMODE_SIZE_OFFSET + 2 || reportedSize > DEVMODE_SIZE) return null;
  return { buffer, mode: readMode(buffer) };
}

function querySupportedModes(api, deviceName) {
  const modes = [];
  const seen = new Set();
  for (let modeIndex = 0; modeIndex < 4096; modeIndex += 1) {
    const buffer = koffi.alloc('uint8', DEVMODE_SIZE);
    koffi.encode(buffer, DEVMODE_SIZE_OFFSET, 'uint16', DEVMODE_SIZE);
    if (!api.enumDisplaySettings(deviceName, modeIndex, buffer, ENUM_MODE_FLAGS)) break;
    const reportedSize = Number(koffi.decode(buffer, DEVMODE_SIZE_OFFSET, 'uint16'));
    if (reportedSize < DEVMODE_SIZE_OFFSET + 2 || reportedSize > DEVMODE_SIZE) continue;
    const mode = normalizeMode(readMode(buffer));
    if (!mode || seen.has(modeKey(mode))) continue;
    seen.add(modeKey(mode));
    modes.push(mode);
  }
  return modes;
}

function enumerateOutputs(api) {
  const outputs = [];
  for (let adapterIndex = 0; adapterIndex < 32; adapterIndex += 1) {
    const adapter = queryDisplayDevice(api, null, adapterIndex);
    if (!adapter) break;
    if ((adapter.stateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) === 0) continue;

    const monitors = [];
    for (let monitorIndex = 0; monitorIndex < 32; monitorIndex += 1) {
      const monitor = queryDisplayDevice(api, adapter.deviceName, monitorIndex);
      if (!monitor) break;
      monitors.push(monitor);
    }
    const mode = queryCurrentMode(api, adapter.deviceName);
    if (!mode) continue;
    outputs.push({
      adapter,
      monitors,
      ...mode,
      currentMode: mode.mode,
      modes: querySupportedModes(api, adapter.deviceName),
    });
  }
  return outputs;
}

function matchingOutputs(outputs, request) {
  if (typeof request?.deviceName === 'string' && request.deviceName.length > 0) {
    let exact = outputs.filter((output) => output.adapter.deviceName === request.deviceName);
    if (typeof request.displayIdentity === 'string' && request.displayIdentity.length > 0) {
      exact = exact.filter((output) => outputIdentity(output) === request.displayIdentity);
    }
    return exact;
  }
  const labels = (output) => [
    output.adapter.deviceString,
    output.adapter.deviceId,
    ...output.monitors.flatMap((monitor) => [monitor.deviceString, monitor.deviceId]),
  ];
  const named = outputs.filter((output) => labels(output).some((label) => displayLabelMatches(request.displayName, label)));
  if (named.length === 1) return named;
  if (named.length > 1) {
    const byMode = named.filter((output) => modeMatches(output.mode, request));
    if (byMode.length === 1) return byMode;
    return named;
  }
  const byMode = outputs.filter((output) => modeMatches(output.mode, request));
  if (!request?.displayName && !request?.resolution) return outputs;
  return byMode.length === 1 ? byMode : [];
}

function requestedMode(request = {}) {
  const resolution = request.resolution ?? request;
  return normalizeMode({
    width: resolution?.width,
    height: resolution?.height,
    refreshRate: request.refreshRate,
    bitsPerPixel: request.bitsPerPixel,
    displayFlags: request.displayFlags,
    orientation: request.orientation,
  });
}

function modeSupported(output, mode) {
  return output.modes.some((candidate) => candidate.width === mode.width
    && candidate.height === mode.height
    && Math.abs(candidate.refreshRate - mode.refreshRate) <= 1
    && (!mode.bitsPerPixel || !candidate.bitsPerPixel || candidate.bitsPerPixel === mode.bitsPerPixel)
    && (!mode.displayFlags || candidate.displayFlags === mode.displayFlags)
    && (!mode.orientation || candidate.orientation === mode.orientation));
}

function setModeFields(buffer, mode) {
  koffi.encode(buffer, DEVMODE_PELS_WIDTH_OFFSET, 'uint32', mode.width);
  koffi.encode(buffer, DEVMODE_PELS_HEIGHT_OFFSET, 'uint32', mode.height);
  koffi.encode(buffer, DEVMODE_DISPLAY_FREQUENCY_OFFSET, 'uint32', mode.refreshRate);
  if (mode.bitsPerPixel) koffi.encode(buffer, DEVMODE_BITS_PER_PIXEL_OFFSET, 'uint32', mode.bitsPerPixel);
  if (mode.displayFlags) koffi.encode(buffer, DEVMODE_DISPLAY_FLAGS_OFFSET, 'uint32', mode.displayFlags);
  if (mode.orientation) koffi.encode(buffer, DEVMODE_ORIENTATION_OFFSET, 'uint16', mode.orientation);
  const fields = Number(koffi.decode(buffer, DEVMODE_FIELDS_OFFSET, 'uint32')) >>> 0;
  koffi.encode(buffer, DEVMODE_FIELDS_OFFSET, 'uint32', fields | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY);
}

function failure(supported, errorCode, message) {
  return { supported, ok: false, errorCode, message };
}

/**
 * Create an injectable controller for enumerating and safely applying display
 * modes. Every successful apply captures the complete current DEVMODE buffer;
 * restore sends that untouched buffer back to Windows.
 */
export function createWindowsDisplayModeController(deps = {}) {
  const platform = deps.platform ?? process.platform;
  let api = null;
  let apiLoadFailed = false;
  // Keep the original mode per Windows output. A single process can have
  // multiple active monitors, and a restore for one output must never replay
  // another output's DEVMODE.
  const capturedByDeviceName = new Map();
  const getApi = () => {
    if (api || apiLoadFailed) return api;
    try {
      api = makeWin32Api(deps);
    } catch {
      apiLoadFailed = true;
    }
    return api;
  };
  const unavailable = () => failure(false, 'windows-only', 'Display-mode control is available only on Windows.');
  const enumerate = () => {
    if (platform !== 'win32') return unavailable();
    const win32 = getApi();
    if (!win32) return failure(false, 'user32-unavailable', 'Windows display APIs are unavailable.');
    try {
      const outputs = enumerateOutputs(win32).map((output) => ({
        deviceName: output.adapter.deviceName,
        displayName: output.adapter.deviceString,
        deviceId: output.adapter.deviceId,
        monitors: output.monitors,
        currentMode: output.currentMode,
        modes: output.modes,
        displayIdentity: outputIdentity(output),
      }));
      return { supported: true, ok: true, outputs };
    } catch {
      return failure(true, 'display-enumeration-failed', 'Windows could not enumerate display modes.');
    }
  };
  const resolve = (request = {}) => {
    if (platform !== 'win32') return unavailable();
    const win32 = getApi();
    if (!win32) return failure(false, 'user32-unavailable', 'Windows display APIs are unavailable.');
    try {
      const outputs = enumerateOutputs(win32);
      const candidates = matchingOutputs(outputs, request);
      if (candidates.length !== 1) {
        return failure(true, candidates.length === 0 ? 'display-not-found' : 'display-ambiguous',
          candidates.length === 0 ? 'Windows could not resolve the selected display.' : 'More than one display matched; no display was changed.');
      }
      const output = candidates[0];
      return { supported: true, ok: true, output: {
        deviceName: output.adapter.deviceName,
        displayName: output.adapter.deviceString,
        deviceId: output.adapter.deviceId,
        currentMode: output.currentMode,
        modes: output.modes,
        displayIdentity: outputIdentity(output),
      } };
    } catch {
      return failure(true, 'display-enumeration-failed', 'Windows could not resolve a display.');
    }
  };
  const apply = (request = {}) => {
    if (platform !== 'win32') return unavailable();
    const win32 = getApi();
    if (!win32) return failure(false, 'user32-unavailable', 'Windows display APIs are unavailable.');
    const mode = requestedMode(request);
    if (!mode) return failure(true, 'invalid-display-mode', 'Display width, height, and refresh rate must be positive values.');
    try {
      const outputs = enumerateOutputs(win32);
      const candidates = matchingOutputs(outputs, request);
      if (candidates.length !== 1) return failure(true, candidates.length === 0 ? 'display-not-found' : 'display-ambiguous',
        candidates.length === 0 ? 'Windows could not resolve the selected display.' : 'More than one display matched; no display was changed.');
      const target = candidates[0];
      if (!modeSupported(target, mode)) return failure(true, 'unsupported-display-mode', 'The requested display mode is not supported by the selected output.');
      const buffer = cloneBuffer(target.buffer);
      setModeFields(buffer, mode);
      const result = Number(win32.changeDisplaySettings(target.adapter.deviceName, buffer, null, CDS_RESET, null));
      if (result !== DISP_CHANGE_SUCCESSFUL) return { supported: true, ok: false, result, errorCode: 'display-mode-apply-failed', message: `Windows rejected the requested display mode (result ${result}).` };
      // Preserve the first pre-Supernative mode for the whole session. If a
      // user switches between multiple higher presets, disabling the feature
      // must still return to the original desktop mode, not the previous
      // higher preset.
      if (request.captureOriginal !== false && !capturedByDeviceName.has(target.adapter.deviceName)) {
        capturedByDeviceName.set(target.adapter.deviceName, {
          deviceName: target.adapter.deviceName,
          buffer: cloneBuffer(target.buffer),
          mode: target.mode,
          displayIdentity: outputIdentity(target),
        });
      }
      return { supported: true, ok: true, result, deviceName: target.adapter.deviceName, mode };
    } catch {
      return failure(true, 'display-mode-apply-failed', 'Windows could not apply the requested display mode.');
    }
  };
  const restore = (request = {}) => {
    if (platform !== 'win32') return unavailable();
    const win32 = getApi();
    if (!win32) return failure(false, 'user32-unavailable', 'Windows display APIs are unavailable.');
    let captured = null;
    let currentOutput = null;
    try {
      const outputs = enumerateOutputs(win32);
      // Resolve by the stable Windows device name first when restoring. This
      // lets the identity check below distinguish a replaced monitor from a
      // merely missing capture and prevents replaying the old DEVMODE onto a
      // new panel that inherited DISPLAY1.
      const matches = typeof request?.deviceName === 'string' && request.deviceName.length > 0
        ? outputs.filter((output) => output.adapter.deviceName === request.deviceName)
        : matchingOutputs(outputs, request);
      if (matches.length === 1) {
        currentOutput = matches[0];
        captured = capturedByDeviceName.get(currentOutput.adapter.deviceName) ?? null;
      }
    } catch {
      captured = null;
    }
    if (!captured) return failure(true, 'no-captured-mode', 'No display mode has been captured for restoration.');
    if (!currentOutput || (captured.displayIdentity && outputIdentity(currentOutput) !== captured.displayIdentity)) {
      return failure(true, 'display-identity-mismatch', 'The display identity changed; no mode was restored on the replacement output.');
    }
    try {
      const result = Number(win32.changeDisplaySettings(captured.deviceName, cloneBuffer(captured.buffer), null, CDS_RESET, null));
      if (result !== DISP_CHANGE_SUCCESSFUL) return { supported: true, ok: false, result, errorCode: 'display-mode-restore-failed', message: `Windows rejected the captured display mode (result ${result}).` };
      // A successful restore completes one transaction. The next enable must
      // capture whatever desktop mode the user is currently using rather than
      // replaying this cycle's stale baseline.
      capturedByDeviceName.delete(captured.deviceName);
      return { supported: true, ok: true, result, deviceName: captured.deviceName, mode: captured.mode };
    } catch {
      return failure(true, 'display-mode-restore-failed', 'Windows could not restore the captured display mode.');
    }
  };
  return { enumerate, resolve, getCurrentMode: resolve, apply, restore };
}

/**
 * Create the Windows display-mode reapply seam.
 *
 * The function is intentionally injectable so the IGCL backend tests never
 * call user32 and so a non-interactive process can report an unavailable
 * display surface instead of pretending that a modeset happened.
 */
export function createWindowsDisplayModeReapply(deps = {}) {
  const platform = deps.platform ?? process.platform;
  let api = null;
  let apiLoadFailed = false;
  const getApi = () => {
    if (api || apiLoadFailed) return api;
    try {
      api = makeWin32Api(deps);
    } catch {
      apiLoadFailed = true;
    }
    return api;
  };

  return {
    reapply(request = {}) {
      if (platform !== 'win32') {
        return { supported: false, reason: 'windows-only' };
      }
      const win32 = getApi();
      if (!win32) {
        return { supported: false, reason: 'user32-unavailable' };
      }
      try {
        const outputs = enumerateOutputs(win32);
        const candidates = matchingOutputs(outputs, request);
        if (candidates.length !== 1) {
          return {
            supported: true,
            ok: false,
            errorCode: candidates.length === 0 ? 'display-not-found' : 'display-ambiguous',
            message: candidates.length === 0
              ? 'Windows could not resolve the selected display for a mode reapply.'
              : 'Windows resolved more than one matching display; no mode was changed.',
          };
        }
        const target = candidates[0];
        const fields = Number(koffi.decode(target.buffer, DEVMODE_FIELDS_OFFSET, 'uint32')) >>> 0;
        koffi.encode(target.buffer, DEVMODE_FIELDS_OFFSET, 'uint32', fields | DM_PELSWIDTH | DM_PELSHEIGHT);
        const result = Number(win32.changeDisplaySettings(target.adapter.deviceName, target.buffer, null, CDS_RESET, null));
        return {
          supported: true,
          ok: result === DISP_CHANGE_SUCCESSFUL,
          result,
          deviceName: target.adapter.deviceName,
          mode: target.mode,
          ...(result === DISP_CHANGE_SUCCESSFUL ? {} : {
            errorCode: 'display-mode-reapply-failed',
            message: `Windows rejected the current display-mode reapply (result ${result}).`,
          }),
        };
      } catch {
        return {
          supported: true,
          ok: false,
          errorCode: 'display-mode-reapply-failed',
          message: 'Windows could not reapply the current display mode; no display mode was changed.',
        };
      }
    },
  };
}
