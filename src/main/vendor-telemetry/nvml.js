// Arc Power - M17c the NVML vendor-telemetry adapter (non-Intel GPU
// readouts - the NVIDIA lane; user scope: ONLY non-Intel GPUs).
//
// NVML (the NVIDIA Management Library) ships with the NVIDIA driver as
// System32\nvml.dll. The adapter loads it at runtime via koffi (the
// igcl-bindings pattern) and samples clock/temp/util/power/VRAM/fan for
// the FIRST enumerated device (index 0). EVERYTHING null-safe: an absent
// DLL, an unbound symbol, a failed NVML call or a garbage value degrades
// that FIELD (honest '-' in the UI), never a crash.
//
// The sample shape is the existing TelemetrySample contract
// (backend.interface.js:138-150): gpuClockMhz, tempC, utilPct, powerW,
// gpuMemUsedBytes (+ fanRpm where exposed) - the overlay/monitoring render
// needs no unit re-mapping. UNIT MAPPING PINNED: NVML reports power in
// MILLIWATTS - powerW = mW / 1000; temperatures are already C (passthrough).
//
// Symbols bound (nvml.h):
//   nvmlInit_v2()                                  -> nvmlReturn_t
//   nvmlShutdown()                                 -> nvmlReturn_t
//   nvmlDeviceGetHandleByIndex_v2(uint)            -> handle (out void*)
//   nvmlDeviceGetClockInfo(handle, clockType, uint*)    (NVML_CLOCK_GRAPHICS 1)
//   nvmlDeviceGetTemperature(handle, sensorType, uint*) (NVML_TEMPERATURE_GPU 0)
//   nvmlDeviceGetUtilizationRates(handle, nvmlUtilization_t*)
//   nvmlDeviceGetMemoryInfo(handle, nvmlMemory_t*)
//   nvmlDeviceGetPowerUsage(handle, uint* mW)
//   nvmlDeviceGetFanSpeed(handle, uint* RPM)
// Structs: nvmlUtilization_t { gpu u32, memory u32 } = 8 bytes;
//          nvmlMemory_t { total u64, free u64, used u64 } = 24 bytes.

import koffi from 'koffi';

const NVML_SUCCESS = 0;
const NVML_CLOCK_GRAPHICS = 1;
const NVML_TEMPERATURE_GPU = 0;

koffi.struct('nvml_utilization_t', {
  gpu: 'uint32',
  memory: 'uint32',
}); // 8 bytes, align 4

koffi.struct('nvml_memory_t', {
  total: 'uint64',
  free: 'uint64',
  used: 'uint64',
}); // 24 bytes, align 8

// Layout assertions (sizes from nvml.h - MSVC x64).
const NVML_EXPECTED_SIZES = {
  nvml_utilization_t: 8,
  nvml_memory_t: 24,
};
for (const [name, expected] of Object.entries(NVML_EXPECTED_SIZES)) {
  const actual = koffi.sizeof(name);
  if (actual !== expected) {
    throw new Error(`Layout mismatch: koffi sizeof(${name}) = ${actual}, expected ${expected} (nvml.h, MSVC x64). Refusing to continue.`);
  }
}

/**
 * The NVML adapter factory. Null-safe: `init()` never throws (a load /
 * bind / NVML failure records initError and the adapter reports
 * unavailable); `sample()` never throws (a failing sub-call omits that
 * field).
 * @param {{
 *   lib?: object|null,             // injected bound lib (tests); loaded at init() otherwise
 *   dllPath?: string,              // default 'nvml.dll' (the driver ships it in System32)
 *   index?: number,                // the device index (default 0 - the first enumerated GPU)
 * }} deps
 * @returns {{
 *   vendor: 'nvidia',
 *   available: () => boolean,
 *   initError: () => string | null,
 *   init: () => void,
 *   sample: () => Promise<object | null>,
 *   close: () => void,
 * }}
 */
export function createNvmlAdapter({ lib = null, dllPath = 'nvml.dll', index = 0 } = {}) {
  let state = { available: false, error: null, handle: null, fn: null };

  function bind(libObj, name, ret, params) {
    try {
      return libObj.func(name, ret, params);
    } catch {
      return null; // an absent export degrades the whole adapter
    }
  }

  function init() {
    if (state.available || state.error !== null) return;
    try {
      const loaded = lib ?? koffi.load(dllPath);
      const fn = {
        init: bind(loaded, 'nvmlInit_v2', 'int', []),
        shutdown: bind(loaded, 'nvmlShutdown', 'int', []),
        handleByIndex: bind(loaded, 'nvmlDeviceGetHandleByIndex_v2', 'int', ['uint', 'void*']),
        clock: bind(loaded, 'nvmlDeviceGetClockInfo', 'int', ['void*', 'uint', 'void*']),
        temp: bind(loaded, 'nvmlDeviceGetTemperature', 'int', ['void*', 'uint', 'void*']),
        util: bind(loaded, 'nvmlDeviceGetUtilizationRates', 'int', ['void*', 'void*']),
        mem: bind(loaded, 'nvmlDeviceGetMemoryInfo', 'int', ['void*', 'void*']),
        power: bind(loaded, 'nvmlDeviceGetPowerUsage', 'int', ['void*', 'void*']),
        fan: bind(loaded, 'nvmlDeviceGetFanSpeed', 'int', ['void*', 'void*']),
      };
      if (!fn.init || !fn.handleByIndex) {
        state.error = 'nvml.dll missing the core symbols (nvmlInit_v2 / nvmlDeviceGetHandleByIndex_v2)';
        return;
      }
      if (fn.init() !== NVML_SUCCESS) {
        state.error = 'nvmlInit_v2 failed (no NVIDIA driver / GPU not supported)';
        return;
      }
      const handleBuf = koffi.alloc('uint8', 8);
      if (fn.handleByIndex(index, handleBuf) !== NVML_SUCCESS) {
        state.error = `nvmlDeviceGetHandleByIndex_v2(${index}) failed (no NVIDIA GPU)`;
        return;
      }
      state.fn = fn;
      state.handle = koffi.decode(handleBuf, 0, 'void*');
      state.available = true;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  function readU32(fnName, args) {
    const fn = state.fn?.[fnName];
    if (!fn) return undefined;
    try {
      const buf = koffi.alloc('uint32', 1);
      if (fn(...args, buf) !== NVML_SUCCESS) return undefined;
      const v = koffi.decode(buf, 0, 'uint32');
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  async function sample() {
    if (!state.available) return null;
    const out = {};
    const clock = readU32('clock', [state.handle, NVML_CLOCK_GRAPHICS]);
    if (clock !== undefined) out.gpuClockMhz = clock;
    const temp = readU32('temp', [state.handle, NVML_TEMPERATURE_GPU]);
    if (temp !== undefined) out.tempC = temp; // C passthrough (pinned)
    const utilBuf = koffi.alloc('nvml_utilization_t', 1);
    try {
      if (state.fn.util(state.handle, utilBuf) === NVML_SUCCESS) {
        const u = koffi.decode(utilBuf, 'nvml_utilization_t');
        if (typeof u.gpu === 'number' && Number.isFinite(u.gpu)) out.utilPct = u.gpu;
      }
    } catch { /* field omitted */ }
    const memBuf = koffi.alloc('nvml_memory_t', 1);
    try {
      if (state.fn.mem(state.handle, memBuf) === NVML_SUCCESS) {
        const m = koffi.decode(memBuf, 'nvml_memory_t');
        if (typeof m.used === 'bigint' || typeof m.used === 'number') out.gpuMemUsedBytes = Number(m.used);
      }
    } catch { /* field omitted */ }
    const mw = readU32('power', [state.handle]);
    if (mw !== undefined) out.powerW = mw / 1000; // mW -> W (pinned)
    const rpm = readU32('fan', [state.handle]);
    if (rpm !== undefined) out.fanRpm = [rpm];
    return out;
  }

  function close() {
    if (state.available && state.fn?.shutdown) {
      try { state.fn.shutdown(); } catch { /* best effort */ }
    }
    state = { available: false, error: null, handle: null, fn: null };
  }

  return {
    vendor: 'nvidia',
    available: () => state.available,
    initError: () => state.error,
    init,
    sample,
    close,
  };
}
