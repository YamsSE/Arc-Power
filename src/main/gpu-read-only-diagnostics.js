import koffi from 'koffi';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CTL_RESULT, CTL_FAN_SPEED_MODE, CTL_FAN_SPEED_UNITS, RESULT_NAME, decodePciProperties } from './backend/igcl-bindings.js';

const MAX_FANS = 64;
const execFileAsync = promisify(execFile);

function resultInfo(code) {
  const numeric = typeof code === 'bigint' ? code.toString() : Number.isFinite(Number(code)) ? Number(code) : null;
  return { code: numeric, name: numeric === null ? null : (RESULT_NAME[numeric] ?? (numeric === 0 ? 'SUCCESS' : 'UNKNOWN_RESULT')) };
}

function errInfo(error) {
  return { message: String(error?.message ?? error), code: error?.code == null ? null : String(error.code) };
}

function initStruct(buf, type) {
  koffi.encode(buf, type, { Size: koffi.sizeof(type), Version: 0 });
}

function fanSpeed(speed) {
  if (!speed) return null;
  return { speed: Number(speed.speed), units: Number(speed.units), unitsName: CTL_FAN_SPEED_UNITS[Number(speed.units)] ?? null };
}

export async function collectGpuReadOnlyDiagnostics(backend) {
  const report = { generatedAt: new Date().toISOString(), dllPath: null, initError: null, windowsControllers: [], adapters: [], errors: [] };
  if (process.platform === 'win32') {
    try {
      const command = 'Get-CimInstance Win32_VideoController | ForEach-Object { $location = $null; try { $location = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName DEVPKEY_Device_LocationInfo -ErrorAction Stop).Data } catch {}; [pscustomobject]@{ name = $_.Name; pnpDeviceId = $_.PNPDeviceID; driverVersion = $_.DriverVersion; status = $_.Status; location = $location } } | ConvertTo-Json -Compress';
      const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const controllers = stdout.trim() ? JSON.parse(stdout) : [];
      report.windowsControllers = Array.isArray(controllers) ? controllers : [controllers];
    } catch (error) { report.errors.push({ field: 'windowsControllers', error: errInfo(error) }); }
  }
  try {
    await backend.init();
    report.dllPath = typeof backend._dllPath === 'string' ? backend._dllPath : null;
    const devices = await backend.listDevices();
    const lib = backend._libOrThrow();
    report.adapters = [];
    for (const device of devices) {
      const row = {
        id: device.id, name: device.name ?? null, pciVendorId: device.pciVendorId ?? null,
        pciDeviceId: device.pciDeviceId ?? null, bdf: device.bdf ?? null,
        deviceKey: device.deviceKey ?? null, driverVersion: device.driverVersion ?? null,
        rebar: null, fans: { enumeration: null, entries: [], symbolPresence: {} }, errors: [],
      };
      let nativeDevice;
      try { nativeDevice = await backend._device(device.id); }
      catch (error) {
        row.errors.push({ field: 'deviceHandle', error: errInfo(error) });
        report.adapters.push(row);
        continue;
      }

      row.rebar = { symbolPresent: typeof lib.ctlPciGetProperties === 'function', result: null, rawHex: null, candidateBytes: { supported: null, enabled: null }, decoded: null, error: null };
      if (row.rebar.symbolPresent) {
        const buf = koffi.alloc('uint8', 64);
        try {
          koffi.encode(buf, 'uint8[64]', Array(64).fill(0));
          koffi.encode(buf, 0, 'uint32', 64);
          koffi.encode(buf, 4, 'uint8', 0);
          const code = lib.ctlPciGetProperties(nativeDevice.handle, buf);
          row.rebar.result = resultInfo(code);
          const bytes = Array.from(koffi.decode(buf, 0, 'uint8[64]'), (byte) => Number(byte) & 255);
          row.rebar.rawHex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
          row.rebar.candidateBytes = { offset52: bytes[52], offset53: bytes[53], offset56: bytes[56], offset57: bytes[57] };
          if (Number(code) === CTL_RESULT.SUCCESS) {
            const decoded = decodePciProperties(buf);
            row.rebar.decoded = { ...decoded, maxBandwidth: decoded.maxBandwidth.toString() };
          }
        } catch (error) { row.rebar.error = errInfo(error); }
        finally { try { koffi.encode(buf, 'uint8[64]', Array(64).fill(0)); } catch { /* buffer is local and discarded */ } }
      }

      const fan = row.fans;
      for (const name of ['ctlEnumFans', 'ctlFanGetProperties', 'ctlFanGetConfig', 'ctlFanGetState', 'ctlFanSetFixedSpeedMode', 'ctlFanSetSpeedTableMode', 'ctlFanSetDefaultMode']) {
        fan.symbolPresence[name] = typeof lib[name] === 'function';
      }
      if (!fan.symbolPresence.ctlEnumFans) {
        fan.enumeration = { firstResult: null, count: null, secondResult: null, error: null };
      } else {
        const countBuf = koffi.alloc('uint32', 1);
        koffi.encode(countBuf, 'uint32', 0);
        let countResult = null;
        try {
          const first = lib.ctlEnumFans(nativeDevice.handle, countBuf, null);
          countResult = resultInfo(first);
          const count = Number(koffi.decode(countBuf, 'uint32')) >>> 0;
          fan.enumeration = { firstResult: countResult, count, secondResult: null, error: null };
          if (Number(first) === CTL_RESULT.SUCCESS && count <= MAX_FANS && count > 0) {
            const handles = koffi.alloc('void*', count);
            koffi.encode(countBuf, 'uint32', count);
            const second = lib.ctlEnumFans(nativeDevice.handle, countBuf, handles);
            fan.enumeration.secondResult = resultInfo(second);
            if (Number(second) === CTL_RESULT.SUCCESS) {
              const returnedCount = Math.min(count, Number(koffi.decode(countBuf, 'uint32')) >>> 0);
              fan.enumeration.returnedCount = returnedCount;
              for (let index = 0; index < returnedCount; index++) {
                const handle = koffi.decode(handles, index * 8, 'void*');
                const entry = { index, properties: null, config: null, states: [], errors: [] };
                // Pointer values are intentionally not included in the report.
                if (fan.symbolPresence.ctlFanGetProperties) {
                  const buf = koffi.alloc('ctl_fan_properties_t', 1); initStruct(buf, 'ctl_fan_properties_t');
                  try {
                    const code = lib.ctlFanGetProperties(handle, buf);
                    entry.properties = { result: resultInfo(code), value: null };
                    if (Number(code) === CTL_RESULT.SUCCESS) {
                      const p = koffi.decode(buf, 'ctl_fan_properties_t');
                      entry.properties.value = { canControl: p.canControl === true, supportedModes: Number(p.supportedModes) >>> 0, supportedModeNames: Object.entries(CTL_FAN_SPEED_MODE).filter(([value]) => ((Number(p.supportedModes) >>> 0) & (1 << Number(value))) !== 0).map(([, name]) => name), supportedUnits: Number(p.supportedUnits) >>> 0, maxRPM: Number(p.maxRPM), maxPoints: Number(p.maxPoints) };
                    }
                  } catch (error) { entry.errors.push({ field: 'properties', error: errInfo(error) }); }
                } else entry.properties = { result: null, value: null, unavailable: true };
                if (fan.symbolPresence.ctlFanGetConfig) {
                  const buf = koffi.alloc('ctl_fan_config_t', 1); initStruct(buf, 'ctl_fan_config_t');
                  try {
                    const code = lib.ctlFanGetConfig(handle, buf);
                    entry.config = { result: resultInfo(code), value: null };
                    if (Number(code) === CTL_RESULT.SUCCESS) {
                      const c = koffi.decode(buf, 'ctl_fan_config_t');
                      const mode = Number(c.mode);
                      const table = c.speedTable;
                      const points = table?.table ?? [];
                      const pointCount = Math.max(0, Math.min(32, points.length, Number(table?.numPoints) | 0));
                      entry.config.value = { mode, modeName: CTL_FAN_SPEED_MODE[mode] ?? null, speedFixed: fanSpeed(c.speedFixed), speedTable: { numPoints: Number(table?.numPoints), points: Array.from({ length: pointCount }, (_, i) => ({ temperature: Number(table.table[i].temperature), speed: fanSpeed(table.table[i].speed) })) } };
                    }
                  } catch (error) { entry.errors.push({ field: 'config', error: errInfo(error) }); }
                } else entry.config = { result: null, value: null, unavailable: true };
                if (fan.symbolPresence.ctlFanGetState) {
                  for (const [unitText, unitName] of Object.entries(CTL_FAN_SPEED_UNITS)) {
                    const unit = Number(unitText); const stateBuf = koffi.alloc('int32', 1);
                    try {
                      const code = lib.ctlFanGetState(handle, unit, stateBuf);
                      entry.states.push({ units: unit, unitsName: unitName, result: resultInfo(code), value: Number(code) === CTL_RESULT.SUCCESS ? Number(koffi.decode(stateBuf, 'int32')) : null });
                    } catch (error) { entry.states.push({ units: unit, unitsName: unitName, result: null, value: null, error: errInfo(error) }); }
                  }
                }
                fan.entries.push(entry);
              }
            }
          } else if (count > MAX_FANS) {
            fan.enumeration.error = { message: `fan count exceeds safety limit (${MAX_FANS})` };
          }
        } catch (error) {
          fan.enumeration ??= { firstResult: countResult, count: null, secondResult: null, error: null };
          fan.enumeration.error = errInfo(error);
        }
      }
      report.adapters.push(row);
    }
  } catch (error) {
    report.initError = errInfo(error);
  }
  return report;
}
