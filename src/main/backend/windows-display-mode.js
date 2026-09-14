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

function readCurrentMode(buffer) {
  return {
    width: Number(koffi.decode(buffer, DEVMODE_PELS_WIDTH_OFFSET, 'uint32')),
    height: Number(koffi.decode(buffer, DEVMODE_PELS_HEIGHT_OFFSET, 'uint32')),
    refreshRate: Number(koffi.decode(buffer, DEVMODE_DISPLAY_FREQUENCY_OFFSET, 'uint32')),
  };
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
  return { buffer, mode: readCurrentMode(buffer) };
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
    outputs.push({ adapter, monitors, ...mode });
  }
  return outputs;
}

function matchingOutputs(outputs, request) {
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
  return byMode.length === 1 ? byMode : [];
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
