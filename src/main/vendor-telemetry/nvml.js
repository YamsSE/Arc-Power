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
//   nvmlDeviceGetClockInfo(handle, clockType, uint*)    (NVML_CLOCK_GRAPHICS 1,
//                                                        NVML_CLOCK_MEM 2 - M17d)
//   nvmlDeviceGetTemperature(handle, sensorType, uint*) (NVML_TEMPERATURE_GPU 0)
//   nvmlDeviceGetUtilizationRates(handle, nvmlUtilization_t*)
//   nvmlDeviceGetMemoryInfo(handle, nvmlMemory_t*)
//   nvmlDeviceGetPowerUsage(handle, uint* mW)
//   nvmlDeviceGetFanSpeed(handle, uint* RPM)
//   nvmlDeviceGetNumGpuCores(handle, uint*)        (M17d - the Compute row)
//   nvmlDeviceGetFieldValues(handle, int, nvmlFieldValue_t*)
//         (M17d - NVML_FI_DEV_MEMORY_TEMP 82 -> vramTempC; the per-field
//         returnStatus NOT_SUPPORTED omits the field - the honest '-')
// Structs: nvmlUtilization_t { gpu u32, memory u32 } = 8 bytes;
//          nvmlMemory_t { total u64, free u64, used u64 } = 24 bytes;
//          nvmlFieldValue_t { fieldId u32, unused u32, value s64,
//                             returnStatus s32, data union 8 bytes } = 32 bytes
//          (the nvmlValue_t union - the temp rides the uiVal half).
//
// M17d: the STATIC-INFO seam - deviceInfo(): { vramBytes, computeCores }.
//   vramBytes = the NVML memory TOTAL (nvmlDeviceGetMemoryInfo) - the
//   NVIDIA primary (the OS registry/AdapterRAM path stays the renderer's
//   fallback); computeCores = nvmlDeviceGetNumGpuCores (no arch restriction -
//   Maxwell-OK - unlike nvmlDeviceGetAttributes numCudaCores, NOT_SUPPORTED
//   on Maxwell). Both bound defensively like every other field (per-symbol
//   absence -> that value null - never a crash).

import koffi from 'koffi';

const NVML_SUCCESS = 0;
const NVML_CLOCK_GRAPHICS = 1;
const NVML_CLOCK_MEM = 2;
const NVML_TEMPERATURE_GPU = 0;
const NVML_FI_DEV_MEMORY_TEMP = 82;

koffi.struct('nvml_utilization_t', {
  gpu: 'uint32',
  memory: 'uint32',
}); // 8 bytes, align 4

koffi.struct('nvml_memory_t', {
  total: 'uint64',
  free: 'uint64',
  used: 'uint64',
}); // 24 bytes, align 8

// nvml.h (MSVC x64): fieldId@0 u32, unused@4 u32, value@8 s64,
// returnStatus@16 s32, data@24 (the nvmlValue_t union - 8 bytes) => 32 bytes.
koffi.struct('nvml_field_value_t', {
  fieldId: 'uint32',
  unused: 'uint32',
  value: 'int64',
  returnStatus: 'int32',
  data: 'int64', // the union placeholder - the uiVal half rides the low 32 bits
}); // 32 bytes, align 8

// Layout assertions (sizes from nvml.h - MSVC x64).
const NVML_EXPECTED_SIZES = {
  nvml_utilization_t: 8,
  nvml_memory_t: 24,
  nvml_field_value_t: 32,
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
 *   deviceInfo: () => { vramBytes: number | null, computeCores: number | null },
 *   close: () => void,
 * }}
 */
export function createNvmlAdapter({ lib = null, dllPath = 'nvml.dll', index = 0, physicalToken = null } = {}) {
  let state = { available: false, error: null, handle: null, fn: null, initialized: false, deviceIndex: index, count: null, identity: null };

  function bind(libObj, name, ret, params) {
    try {
      return libObj.func(name, ret, params);
    } catch {
      return null; // an absent export degrades that FIELD (never the whole adapter)
    }
  }

  function init() {
    if (state.available || state.error !== null) return;
    try {
      const loaded = lib ?? koffi.load(dllPath);
      const fn = {
        init: bind(loaded, 'nvmlInit_v2', 'int', []),
        shutdown: bind(loaded, 'nvmlShutdown', 'int', []),
        count: bind(loaded, 'nvmlDeviceGetCount_v2', 'int', ['void*']),
        handleByIndex: bind(loaded, 'nvmlDeviceGetHandleByIndex_v2', 'int', ['uint', 'void*']),
        uuid: bind(loaded, 'nvmlDeviceGetUUID', 'int', ['void*', 'void*', 'uint']),
        pciInfo: bind(loaded, 'nvmlDeviceGetPciInfo_v3', 'int', ['void*', 'void*'])
          ?? bind(loaded, 'nvmlDeviceGetPciInfo_v2', 'int', ['void*', 'void*']),
        clock: bind(loaded, 'nvmlDeviceGetClockInfo', 'int', ['void*', 'uint', 'void*']),
        temp: bind(loaded, 'nvmlDeviceGetTemperature', 'int', ['void*', 'uint', 'void*']),
        util: bind(loaded, 'nvmlDeviceGetUtilizationRates', 'int', ['void*', 'void*']),
        mem: bind(loaded, 'nvmlDeviceGetMemoryInfo', 'int', ['void*', 'void*']),
        power: bind(loaded, 'nvmlDeviceGetPowerUsage', 'int', ['void*', 'void*']),
        fan: bind(loaded, 'nvmlDeviceGetFanSpeed', 'int', ['void*', 'void*']),
        // M17d: the Compute-row + VRAM-temp sources (per-symbol absence ->
        // that field absent - the same defensive contract as the rest).
        cores: bind(loaded, 'nvmlDeviceGetNumGpuCores', 'int', ['void*', 'void*']),
        fieldValues: bind(loaded, 'nvmlDeviceGetFieldValues', 'int', ['void*', 'int', 'void*']),
      };
      if (!fn.init || !fn.handleByIndex) {
        state.error = 'nvml.dll missing the core symbols (nvmlInit_v2 / nvmlDeviceGetHandleByIndex_v2)';
        return;
      }
      if (fn.init() !== NVML_SUCCESS) {
        state.error = 'nvmlInit_v2 failed (no NVIDIA driver / GPU not supported)';
        return;
      }
      // A successful nvmlInit_v2 must be paired with nvmlShutdown even when
      // handle discovery or a later identity query fails.
      state.fn = fn;
      state.initialized = true;
      const handleBuf = koffi.alloc('uint8', 8);
      if (fn.handleByIndex(index, handleBuf) !== NVML_SUCCESS) {
        state.error = `nvmlDeviceGetHandleByIndex_v2(${index}) failed (no NVIDIA GPU)`;
        return;
      }
      state.handle = koffi.decode(handleBuf, 0, 'void*');
      if (fn.count) {
        try {
          const countBuf = koffi.alloc('uint32', 1);
          if (fn.count(countBuf) === NVML_SUCCESS) state.count = koffi.decode(countBuf, 0, 'uint32');
        } catch { /* the identity resolver can still use the selected handle */ }
      }
      state.deviceIndex = index;
      state.available = true;
      state.identity = readIdentity(state.handle, index);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  function configuredToken(deviceIndex) {
    const value = Array.isArray(physicalToken) ? physicalToken[deviceIndex] : physicalToken;
    return typeof value === 'string' && value.length > 0 ? `nvml:${value}` : null;
  }

  function parseBusId(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    const match = text.match(/^(?:PCI:)?([0-9a-f]+):([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (!match) return null;
    const domain = Number.parseInt(match[1], 16);
    const bus = Number.parseInt(match[2], 16);
    const device = Number.parseInt(match[3], 16);
    const fn = Number.parseInt(match[4], 10);
    if (![domain, bus, device, fn].every(Number.isFinite)
      || domain > 0xffff || bus > 0xff || device > 0xff) return null;
    return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
  }

  function readIdentity(handle, deviceIndex) {
    const identity = {};
    const configured = configuredToken(deviceIndex);
    if (configured) identity.physicalToken = configured;
    if (!identity.physicalToken && state.fn?.uuid) {
      try {
        const buf = Buffer.alloc(96, 0);
        if (state.fn.uuid(handle, buf, 96) === NVML_SUCCESS) {
          const uuid = buf.toString('utf8').split('\0', 1)[0].trim();
          if (uuid) identity.physicalToken = `nvml:${uuid}`;
        }
      } catch { /* try PCI identity */ }
    }
    if (state.fn?.pciInfo) {
      try {
        const buf = Buffer.alloc(64, 0);
        if (state.fn.pciInfo(handle, buf) === NVML_SUCCESS) {
          // nvmlPciInfo_t starts with char busId[32], followed by domain,
          // bus, device, and subsystem ids. Prefer the canonical busId text
          // so v2/v3 layouts stay compatible; the numeric fallback uses the
          // real post-busId offsets, never bytes from the string field.
          const busId = buf.toString('utf8', 0, 32).split('\0', 1)[0];
          const parsed = parseBusId(busId);
          if (parsed) identity.physicalBdf = parsed;
          else {
            const domain = buf.readUInt32LE(32);
            const bus = buf.readUInt32LE(36);
            const device = buf.readUInt32LE(40);
            const fn = buf.length >= 48 ? buf.readUInt32LE(44) : 0;
            if (domain <= 0xffff && bus <= 0xff && device <= 0xff && fn <= 7) {
              identity.physicalBdf = `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
            }
          }
        }
      } catch { /* identity remains partially available */ }
    }
    return Object.keys(identity).length > 0 ? identity : null;
  }

  function handleAt(deviceIndex) {
    if (!state.fn?.handleByIndex || !Number.isInteger(deviceIndex) || deviceIndex < 0) return null;
    const handleBuf = koffi.alloc('uint8', 8);
    if (state.fn.handleByIndex(deviceIndex, handleBuf) !== NVML_SUCCESS) return null;
    return koffi.decode(handleBuf, 0, 'void*');
  }

  function selectDevice(deviceIndex) {
    if (!state.available || !Number.isInteger(deviceIndex) || (Number.isInteger(state.count) && deviceIndex >= state.count)) return false;
    try {
      const handle = handleAt(deviceIndex);
      if (!handle) return false;
      state.handle = handle;
      state.deviceIndex = deviceIndex;
      state.identity = readIdentity(handle, deviceIndex);
      return true;
    } catch {
      return false;
    }
  }

  async function enumerateDevices() {
    if (!state.available || !Number.isInteger(state.count)) return null;
    const entries = [];
    for (let i = 0; i < state.count; i += 1) {
      try {
        const handle = handleAt(i);
        if (handle) entries.push({ index: i, ...(readIdentity(handle, i) ?? {}) });
      } catch { /* skip a provider entry that cannot be inspected */ }
    }
    return entries;
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
    // M17d: the memory clock (NVML_CLOCK_MEM - WORKS on Maxwell - the
    // no-Intel dashboard Clocks row's live memory half).
    const memClock = readU32('clock', [state.handle, NVML_CLOCK_MEM]);
    if (memClock !== undefined) out.memClockMhz = memClock;
    const temp = readU32('temp', [state.handle, NVML_TEMPERATURE_GPU]);
    if (temp !== undefined) out.tempC = temp; // C passthrough (pinned)
    // M17d: the VRAM temperature via nvmlDeviceGetFieldValues
    // (NVML_FI_DEV_MEMORY_TEMP - the per-field returnStatus decides: SUCCESS
    // -> the field rides; NOT_SUPPORTED (Maxwell-class) -> the field stays
    // absent - the honest '-' in the UI; a failed call degrades the same).
    if (state.fn.fieldValues) {
      const fvBuf = koffi.alloc('nvml_field_value_t', 1);
      try {
        koffi.encode(fvBuf, 'nvml_field_value_t', { fieldId: NVML_FI_DEV_MEMORY_TEMP, unused: 0, value: 0n, returnStatus: 0, data: 0n });
        if (state.fn.fieldValues(state.handle, 1, fvBuf) === NVML_SUCCESS) {
          const fv = koffi.decode(fvBuf, 'nvml_field_value_t');
          if (fv.returnStatus === NVML_SUCCESS) {
            const uiVal = koffi.decode(fvBuf, koffi.offsetof('nvml_field_value_t', 'data'), 'uint32');
            if (typeof uiVal === 'number' && Number.isFinite(uiVal)) out.vramTempC = uiVal;
          }
        }
      } catch { /* field omitted */ }
    }
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
    // M17d: the compute-cores ride the sample too (the mock fixture parity -
    // the fixture sample carries numCores, the Compute row reads the same
    // source through deviceInfo()).
    const cores = readU32('cores', [state.handle]);
    if (cores !== undefined) out.numCores = cores;
    return out;
  }

  /**
   * M17d: the STATIC-INFO seam - the no-Intel dashboard rows' source.
   * vramBytes = the NVML memory TOTAL (the NVIDIA primary; the OS
   * registry/AdapterRAM path stays the renderer-side fallback);
   * computeCores = nvmlDeviceGetNumGpuCores (the Compute row; honest null
   * when the symbol is absent / the call fails). Never throws.
   * @returns {{ vramBytes: number | null, computeCores: number | null }}
   */
  function deviceInfo() {
    if (!state.available) return { vramBytes: null, computeCores: null };
    let vramBytes = null;
    if (state.fn.mem) {
      const memBuf = koffi.alloc('nvml_memory_t', 1);
      try {
        if (state.fn.mem(state.handle, memBuf) === NVML_SUCCESS) {
          const m = koffi.decode(memBuf, 'nvml_memory_t');
          const total = Number(m.total);
          if (typeof total === 'number' && Number.isFinite(total) && total > 0) vramBytes = Math.floor(total);
        }
      } catch { /* honest null */ }
    }
    const cores = readU32('cores', [state.handle]);
    return { vramBytes, computeCores: cores !== undefined ? cores : null };
  }

  function close() {
    if (state.initialized && state.fn?.shutdown) {
      try { state.fn.shutdown(); } catch { /* best effort */ }
    }
    state = { available: false, error: null, handle: null, fn: null, initialized: false, deviceIndex: index, count: null, identity: null };
  }

  return {
    vendor: 'nvidia',
    get deviceIndex() { return state.deviceIndex; },
    get physicalToken() { return state.identity?.physicalToken ?? null; },
    get physicalBdf() { return state.identity?.physicalBdf ?? null; },
    get physicalUniqueToken() { return state.identity?.physicalToken ?? null; },
    available: () => state.available,
    initError: () => state.error,
    init,
    enumerateDevices,
    selectDevice,
    sample,
    deviceInfo,
    close,
  };
}
