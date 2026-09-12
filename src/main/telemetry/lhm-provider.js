// LibreHardwareMonitor-backed hardware telemetry.
//
// LibreHardwareMonitor is a managed .NET library, so the Electron main
// process talks to a small read-only JSON-lines bridge instead of loading the
// library into Node. GPU utilization is deliberately not read from LHM here:
// the Windows GPU Engine counter is the authoritative utilization source in
// Arc Power, while RTSS remains the FPS/frametime source.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIBRE_HARDWARE_MONITOR_VERSION = '0.9.6';
export const LIBRE_HARDWARE_MONITOR_SOURCE = 'LibreHardwareMonitor';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SAMPLE_TTL_MS = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 6000;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedIdentity(value) {
  return normalizedText(value)?.toLowerCase() ?? null;
}

function numberFromSuffix(value) {
  const text = normalizedText(value);
  if (!text) return null;
  const match = text.match(/(?:0x)?([0-9a-f]{1,8})$/i);
  if (!match) return null;
  const trimmed = match[1].toLowerCase().replace(/^0+/, '') || '0';
  return trimmed.padStart(4, '0');
}

function targetPciDeviceId(target) {
  return numberFromSuffix(
    target?.pciDeviceId
      ?? target?.deviceIdHex
      ?? target?.osController?.pciDeviceId
      ?? target?.osController?.deviceIdHex,
  );
}

function targetPciVendorId(target) {
  return numberFromSuffix(
    target?.pciVendorId
      ?? target?.osController?.pciVendorId,
  );
}

function hardwareTypeOf(hardware) {
  return normalizedText(hardware?.type)?.toLowerCase() ?? '';
}

function sensorTypeOf(sensor) {
  return normalizedText(sensor?.type)?.toLowerCase() ?? '';
}

function sensorNameOf(sensor) {
  return normalizedText(sensor?.name)?.toLowerCase() ?? '';
}

function sensorValue(sensor) {
  return finite(sensor?.value);
}

function firstValue(sensors, predicate) {
  for (const sensor of sensors) {
    if (!predicate(sensor)) continue;
    const value = sensorValue(sensor);
    if (value !== null) return value;
  }
  return null;
}

function valuesOf(sensors, predicate) {
  return sensors
    .filter(predicate)
    .map(sensorValue)
    .filter((value) => value !== null);
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emptyHardwareSample() {
  return {
    telemetryProvider: LIBRE_HARDWARE_MONITOR_SOURCE,
    telemetryProviderVersion: LIBRE_HARDWARE_MONITOR_VERSION,
    cpuUtilPct: null,
    cpuTempC: null,
    cpuFreqMhz: null,
    cpuPowerW: null,
    memoryUsedBytes: null,
    gpuClockMhz: null,
    memClockMhz: null,
    tempC: null,
    vramTempC: null,
    gpuVoltageV: null,
    powerW: null,
    fanRpm: null,
    gpuMemUsedBytes: null,
  };
}

function mapSystemSensors(hardware) {
  const out = {};
  const cpu = hardware.find((row) => hardwareTypeOf(row) === 'cpu');
  if (cpu) {
    const sensors = Array.isArray(cpu.sensors) ? cpu.sensors : [];
    out.cpuUtilPct = firstValue(sensors, (sensor) => (
      sensorTypeOf(sensor) === 'load' && /cpu total/i.test(sensorNameOf(sensor))
    ));
    out.cpuTempC = firstValue(sensors, (sensor) => (
      sensorTypeOf(sensor) === 'temperature'
      && /core max|cpu package|cpu core/i.test(sensorNameOf(sensor))
    ));
    const coreClocks = valuesOf(sensors, (sensor) => (
      sensorTypeOf(sensor) === 'clock' && /cpu core/i.test(sensorNameOf(sensor))
    ));
    out.cpuFreqMhz = average(coreClocks) ?? firstValue(sensors, (sensor) => (
      sensorTypeOf(sensor) === 'clock'
    ));
    out.cpuPowerW = firstValue(sensors, (sensor) => (
      sensorTypeOf(sensor) === 'power' && /cpu package/i.test(sensorNameOf(sensor))
    ));
  }

  const memory = hardware.find((row) => (
    hardwareTypeOf(row) === 'memory' && /total memory/i.test(normalizedText(row?.name) ?? '')
  )) ?? hardware.find((row) => hardwareTypeOf(row) === 'memory');
  if (memory) {
    const sensors = Array.isArray(memory.sensors) ? memory.sensors : [];
    // LibreHardwareMonitor's Memory Data sensors are reported in GiB. Keep
    // Arc Power's public contract in bytes and do not use the old WMI/RAM
    // detector as a fallback when LHM is active.
    const usedGiB = firstValue(sensors, (sensor) => (
      sensorTypeOf(sensor) === 'data' && /memory used/i.test(sensorNameOf(sensor))
    ));
    out.memoryUsedBytes = usedGiB === null ? null : usedGiB * 1024 ** 3;
  }
  return out;
}

function gpuHardwareMatches(hardware, target, allGpus) {
  const identifier = normalizedIdentity(hardware?.identifier);
  if (!identifier || !identifier.includes('gpu-')) return false;
  const wantedDevice = targetPciDeviceId(target);
  if (!wantedDevice) return false;
  const idMatch = identifier.match(/\/0x([0-9a-f]{1,8})(?:\/|$)/i);
  if (!idMatch || idMatch[1].toLowerCase().padStart(4, '0') !== wantedDevice) return false;

  // LHM's public hardware identifier contains the PCI device id, but not a
  // BDF/LUID. Refuse an ambiguous duplicate model rather than binding one
  // physical GPU by enumeration order.
  const sameDevice = allGpus.filter((row) => {
    const rowId = normalizedIdentity(row?.identifier);
    const rowMatch = rowId?.match(/\/0x([0-9a-f]{1,8})(?:\/|$)/i);
    if (!rowMatch) return false;
    const rowIdText = rowMatch[1].toLowerCase().replace(/^0+/, '') || '0';
    return rowIdText.padStart(4, '0') === wantedDevice;
  });
  if (sameDevice.length !== 1) return false;

  const wantedVendor = targetPciVendorId(target);
  if (!wantedVendor) return true;
  const vendorByType = {
    '8086': 'gpu-intel',
    '1002': 'gpu-amd',
    '10de': 'gpu-nvidia',
  };
  return identifier.includes(vendorByType[wantedVendor] ?? 'gpu-');
}

export function mapLibreHardwareMonitorSnapshot(payload, target = null) {
  const out = emptyHardwareSample();
  if (!payload || payload.ok !== true || !Array.isArray(payload.hardware)) return out;
  const hardware = payload.hardware.filter((row) => row && typeof row === 'object');
  Object.assign(out, mapSystemSensors(hardware));
  const gpus = hardware.filter((row) => hardwareTypeOf(row).startsWith('gpu'));
  const gpu = gpus.find((row) => gpuHardwareMatches(row, target, gpus));
  if (!gpu) return out;

  const sensors = Array.isArray(gpu.sensors) ? gpu.sensors : [];
  out.gpuClockMhz = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'clock' && /^gpu core$/i.test(sensorNameOf(sensor))
  ));
  out.memClockMhz = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'clock' && /gpu memory|memory clock|vram/i.test(sensorNameOf(sensor))
  ));
  out.tempC = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'temperature' && /gpu core|gpu package|gpu/i.test(sensorNameOf(sensor))
  ));
  out.vramTempC = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'temperature' && /vram|gpu memory|memory junction/i.test(sensorNameOf(sensor))
  ));
  out.gpuVoltageV = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'voltage' && /gpu core|gpu/i.test(sensorNameOf(sensor))
  ));
  out.powerW = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'power' && /gpu package|gpu power|gpu/i.test(sensorNameOf(sensor))
  ));
  const fan = firstValue(sensors, (sensor) => (
    sensorTypeOf(sensor) === 'fan' && /gpu fan|gpu/i.test(sensorNameOf(sensor))
  ));
  out.fanRpm = fan === null ? null : [fan];
  const usedMiB = firstValue(sensors, (sensor) => (
    (sensorTypeOf(sensor) === 'smalldata' || sensorTypeOf(sensor) === 'data')
      && /gpu memory used|memory used|vram used/i.test(sensorNameOf(sensor))
  ));
  out.gpuMemUsedBytes = usedMiB === null ? null : usedMiB * 1024 ** 2;
  return out;
}

function defaultRuntimeDirectory() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'lhm');
  const development = path.join(moduleDir, 'lhm-runtime');
  if (packaged && existsSync(path.join(packaged, 'ArcPower.LhmBridge.exe'))) return packaged;
  if (existsSync(path.join(development, 'ArcPower.LhmBridge.exe'))) return development;
  return packaged ?? development;
}

/**
 * Create the one shared LHM bridge used by all telemetry consumers. The
 * bridge is lazy and cached for a short interval, so a selected lane and the
 * secondary overlay lanes never start one privileged hardware sampler per
 * GPU.
 *
 * @param {{ runtimeDirectory?: string, spawn?: Function, sampleTtlMs?: number, requestTimeoutMs?: number }} options
 */
export function createLhmTelemetry(options = {}) {
  const runtimeDirectory = options.runtimeDirectory ?? defaultRuntimeDirectory();
  const spawnImpl = options.spawn ?? nodeSpawn;
  const sampleTtlMs = Math.max(0, options.sampleTtlMs ?? DEFAULT_SAMPLE_TTL_MS);
  const requestTimeoutMs = Math.max(500, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let child = null;
  let stdoutBuffer = '';
  let pending = null;
  let startPromise = null;
  let refreshPromise = null;
  let latest = null;
  let latestAt = 0;
  let lastError = null;
  let closed = false;

  const failPending = (error) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(error);
  };

  const disposeChild = () => {
    const current = child;
    child = null;
    stdoutBuffer = '';
    failPending(new Error('LibreHardwareMonitor bridge stopped'));
    if (current) {
      try { current.kill(); } catch { /* best effort */ }
    }
  };

  const handleLine = (line) => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (value?.ok !== true) {
      const error = new Error(String(value?.error ?? 'LibreHardwareMonitor bridge returned an error'));
      lastError = error.message;
      current.reject(error);
      return;
    }
    current.resolve(value);
  };

  const start = async () => {
    if (closed) throw new Error('LibreHardwareMonitor telemetry is closed');
    if (child) return;
    const executable = path.join(runtimeDirectory, 'ArcPower.LhmBridge.exe');
    if (!existsSync(executable)) throw new Error(`LibreHardwareMonitor bridge is not packaged: ${executable}`);
    child = spawnImpl(executable, [], {
      cwd: runtimeDirectory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += String(chunk);
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr?.on('data', () => {});
    child.once('error', (error) => {
      lastError = error instanceof Error ? error.message : String(error);
      disposeChild();
    });
    child.once('exit', () => disposeChild());
    await request('ping');
  };

  const request = (op) => new Promise((resolve, reject) => {
    if (!child?.stdin?.writable) {
      reject(new Error('LibreHardwareMonitor bridge is unavailable'));
      return;
    }
    if (pending) {
      reject(new Error('LibreHardwareMonitor bridge request already in flight'));
      return;
    }
    const timer = setTimeout(() => {
      if (!pending || pending.op !== op) return;
      pending = null;
      lastError = `LibreHardwareMonitor ${op} request timed out`;
      reject(new Error(lastError));
    }, requestTimeoutMs);
    pending = { op, resolve, reject, timer };
    try {
      child.stdin.write(`${JSON.stringify({ op })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending = null;
      reject(error);
    }
  });

  const ensureStarted = async () => {
    if (startPromise) return startPromise;
    startPromise = start().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      disposeChild();
      throw error;
    }).finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  const refresh = async () => {
    const now = Date.now();
    if (latest && now - latestAt <= sampleTtlMs) return latest;
    // Overlay lanes for multiple physical GPUs tick together. Coalesce the
    // shared bridge request so one lane cannot lose its sample merely because
    // another lane reached this point first.
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      await ensureStarted();
      const payload = await request('sample');
      latest = payload;
      latestAt = Date.now();
      return payload;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  };

  return {
    available: () => existsSync(path.join(runtimeDirectory, 'ArcPower.LhmBridge.exe')),
    async sampleForTarget(target = null) {
      try {
        return mapLibreHardwareMonitorSnapshot(await refresh(), target);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return null;
      }
    },
    status: () => ({
      available: existsSync(path.join(runtimeDirectory, 'ArcPower.LhmBridge.exe')),
      running: child !== null,
      lastError,
      provider: LIBRE_HARDWARE_MONITOR_SOURCE,
      version: LIBRE_HARDWARE_MONITOR_VERSION,
    }),
    async close() {
      closed = true;
      latest = null;
      latestAt = 0;
      disposeChild();
    },
  };
}
