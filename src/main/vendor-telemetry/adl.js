// Arc Power - M17c the ADL vendor-telemetry adapter (non-Intel GPU
// readouts - the AMD lane; user scope: ONLY non-Intel GPUs).
//
// ADL (the AMD Display Library) ships with the AMD driver as
// System32\atiadlxx.dll. The adapter loads it at runtime via koffi (the
// igcl-bindings pattern) and samples clock/util/temp/power/fan for the
// first ACTIVE adapter. EVERYTHING null-safe: an absent DLL, an unbound
// symbol, a failed ADL call or a garbage value degrades that FIELD
// (honest '-' in the UI), never a crash.
//
// The sample shape is the existing TelemetrySample contract
// (backend.interface.js:138-150): gpuClockMhz, tempC, utilPct, powerW,
// gpuMemUsedBytes (+ fanRpm where exposed). UNIT MAPPING PINNED: ADL
// reports utilization as % (passthrough) and temperature in C (the
// ADLPMActivity.iTemperature field is already degrees C); the power draw
// (iPowerDraw) is in MILLIWATTS - powerW = mW / 1000. A source that ADL
// does not expose (used VRAM has no ADL field) stays absent - honest '-'.
//
// Symbols bound (adl_sdk.h):
//   ADL_Main_Control_Create(void* mallocCallback, int enumAdapters) -> ADL_OK 0
//   ADL_Main_Control_Destroy()                                          -> ADL_OK 0
//   ADL_Adapter_NumberOfAdapters_Get(int* count)
//   ADL_Adapter_Active_Get(int adapterIndex, int* active)
//   ADL_Overdrive5_CurrentActivity_Get(int adapterIndex, ADLPMActivity*)
//       -> clock / util % / temperature C / power draw mW in ONE struct
//   ADL_Overdrive5_FanSpeed_Get(int adapterIndex, int* speedPct, int* rpm)
// Struct: ADLPMActivity { 11 x int32 } = 44 bytes:
//   iEngineClock@0, iMemoryClock@4, iVddc@8, iGPUUtilPercent@12,
//   iCurrentActivityPercent@16, iCurrentPerformanceLevel@20,
//   iCurrentBusSpeed@24, iCurrentBusLanesPerLink@28, iCurrentBusLanesInUse@32,
//   iTemperature@36, iPowerDraw@40.

import koffi from 'koffi';

const ADL_OK = 0;
// ADLAdapterInfo (ADL SDK, sequential x86 layout): Size, AdapterIndex,
// UDID[256], BusNumber, DeviceNumber, FunctionNumber, ... . The BDF is the
// stable bridge to Windows PnP LocationInfo; adapter ordinal is never used
// when more than one AMD adapter exists.
const ADL_ADAPTER_INFO_SIZE = 1572;
const ADL_INFO_BUS_OFFSET = 264;
const ADL_INFO_DEVICE_OFFSET = 268;
const ADL_INFO_FUNCTION_OFFSET = 272;

// ADLPMActivity: 11 x int32 = 44 bytes (adl_sdk.h, MSVC x64).
koffi.struct('adl_pm_activity_t', {
  iEngineClock: 'int32',            // @0  MHz
  iMemoryClock: 'int32',            // @4
  iVddc: 'int32',                   // @8
  iGPUUtilPercent: 'int32',         // @12 %
  iCurrentActivityPercent: 'int32', // @16 %
  iCurrentPerformanceLevel: 'int32', // @20
  iCurrentBusSpeed: 'int32',        // @24
  iCurrentBusLanesPerLink: 'int32', // @28
  iCurrentBusLanesInUse: 'int32',   // @32
  iTemperature: 'int32',            // @36 C
  iPowerDraw: 'int32',              // @40 mW
}); // 44 bytes, align 4

// Layout assertion (adl_sdk.h - MSVC x64).
const ADL_EXPECTED_SIZES = {
  adl_pm_activity_t: 44,
};
for (const [name, expected] of Object.entries(ADL_EXPECTED_SIZES)) {
  const actual = koffi.sizeof(name);
  if (actual !== expected) {
    throw new Error(`Layout mismatch: koffi sizeof(${name}) = ${actual}, expected ${expected} (adl_sdk.h, MSVC x64). Refusing to continue.`);
  }
}

/**
 * The ADL adapter factory. Null-safe: `init()` never throws (a load /
 * bind / ADL failure records initError and the adapter reports
 * unavailable); `sample()` never throws (a failing sub-call omits that
 * field).
 * @param {{
 *   lib?: object|null,             // injected bound lib (tests); loaded at init() otherwise
 *   dllPath?: string,              // default 'atiadlxx.dll' (the AMD driver ships it in System32)
 * }} deps
 * @returns {{
 *   vendor: 'amd',
 *   available: () => boolean,
 *   initError: () => string | null,
 *   init: () => void,
 *   sample: () => Promise<object | null>,
 *   deviceInfo: () => { vramBytes: number | null, computeCores: number | null },
 *   close: () => void,
 * }}
 */
export function createAdlAdapter({ lib = null, dllPath = 'atiadlxx.dll', index = null, physicalToken = null } = {}) {
  let state = { available: false, error: null, fn: null, initialized: false, adapterIndex: -1, count: 0, identity: null };

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
        create: bind(loaded, 'ADL_Main_Control_Create', 'int', ['void*', 'int']),
        destroy: bind(loaded, 'ADL_Main_Control_Destroy', 'int', []),
        count: bind(loaded, 'ADL_Adapter_NumberOfAdapters_Get', 'int', ['void*']),
        adapterId: bind(loaded, 'ADL_Adapter_ID_Get', 'int', ['int', 'void*']),
        adapterInfo: bind(loaded, 'ADL_Adapter_AdapterInfo_Get', 'int', ['void*', 'int']),
        active: bind(loaded, 'ADL_Adapter_Active_Get', 'int', ['int', 'void*']),
        activity: bind(loaded, 'ADL_Overdrive5_CurrentActivity_Get', 'int', ['int', 'void*']),
        fan: bind(loaded, 'ADL_Overdrive5_FanSpeed_Get', 'int', ['int', 'void*', 'void*']),
      };
      if (!fn.create || !fn.count) {
        state.error = 'atiadlxx.dll missing the core symbols (ADL_Main_Control_Create / ADL_Adapter_NumberOfAdapters_Get)';
        return;
      }
      // The malloc callback is reserved (pass a null function pointer).
      if (fn.create(0n, 1) !== ADL_OK) {
        state.error = 'ADL_Main_Control_Create failed (no AMD driver / adapter)';
        return;
      }
      // Keep the bound destroy function visible even if a later startup
      // query fails; startFor() closes rejected candidates as well as live
      // owners, including this partially initialized ADL context.
      state.fn = fn;
      state.initialized = true;
      const countBuf = koffi.alloc('int32', 1);
      if (fn.count(countBuf) !== ADL_OK) {
        state.error = 'ADL_Adapter_NumberOfAdapters_Get failed';
        return;
      }
      const count = koffi.decode(countBuf, 0, 'int32') | 0;
      let pick = -1;
      const activeBuf = koffi.alloc('int32', 1);
      if (Number.isInteger(index) && index >= 0 && index < count) {
        try {
          if (!fn.active || fn.active(index, activeBuf) === ADL_OK) pick = index;
        } catch { pick = -1; }
      }
      for (let i = 0; i < count && pick < 0; i++) {
        try {
          if (fn.active(i, activeBuf) === ADL_OK && (koffi.decode(activeBuf, 0, 'int32') | 0) !== 0) {
            pick = i;
            break;
          }
        } catch { /* try the next index */ }
      }
      if (pick < 0 && count > 0) pick = 0; // no active flag -> the first adapter
      state.count = Math.max(0, count);
      state.adapterIndex = pick;
      state.available = true;
      state.identity = readIdentity(pick);
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  function readIdentity(adapterIndex) {
    const identity = {};
    if (state.fn?.adapterInfo && adapterIndex >= 0 && Number.isInteger(state.count) && state.count > 0) {
      try {
        const buf = Buffer.alloc(ADL_ADAPTER_INFO_SIZE * state.count);
        if (state.fn.adapterInfo(buf, ADL_ADAPTER_INFO_SIZE * state.count) === ADL_OK) {
          const offset = adapterIndex * ADL_ADAPTER_INFO_SIZE;
          const size = buf.readInt32LE(offset);
          const bus = buf.readInt32LE(offset + ADL_INFO_BUS_OFFSET);
          const device = buf.readInt32LE(offset + ADL_INFO_DEVICE_OFFSET);
          const fn = buf.readInt32LE(offset + ADL_INFO_FUNCTION_OFFSET);
          if (size > 0 && bus >= 0 && bus <= 0xff && device >= 0 && device <= 0xff && fn >= 0 && fn <= 7 && (bus !== 0 || device !== 0)) {
            identity.physicalBdf = `0000:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
          }
        }
      } catch { /* fall back to the ADL adapter token */ }
    }
    if (typeof physicalToken === 'string' && physicalToken.length > 0) identity.physicalToken = `adl:${physicalToken}`;
    if (!identity.physicalToken && state.fn?.adapterId && adapterIndex >= 0) {
      try {
        const idBuf = koffi.alloc('int32', 1);
        if (state.fn.adapterId(adapterIndex, idBuf) === ADL_OK) {
          const id = koffi.decode(idBuf, 0, 'int32');
          if (Number.isInteger(id)) identity.physicalToken = `adl:${id}`;
        }
      } catch { /* identity remains BDF-only or absent */ }
    }
    return Object.keys(identity).length > 0 ? identity : null;
  }

  function selectDevice(adapterIndex) {
    if (!state.available || !Number.isInteger(adapterIndex) || adapterIndex < 0 || adapterIndex >= state.count) return false;
    state.adapterIndex = adapterIndex;
    state.identity = readIdentity(adapterIndex);
    return true;
  }

  async function enumerateDevices() {
    if (!state.available) return [];
    return Array.from({ length: state.count }, (_, i) => ({
      index: i,
      ...(readIdentity(i) ?? {}),
    }));
  }

  async function sample() {
    if (!state.available || state.adapterIndex < 0) return null;
    const out = {};
    // The OD5 current-activity struct: clock / util % / temp C / power mW
    // in one call.
    const actBuf = koffi.alloc('adl_pm_activity_t', 1);
    try {
      if (state.fn.activity(state.adapterIndex, actBuf) === ADL_OK) {
        const a = koffi.decode(actBuf, 'adl_pm_activity_t');
        if (Number.isFinite(a.iEngineClock)) out.gpuClockMhz = a.iEngineClock;
        if (Number.isFinite(a.iGPUUtilPercent)) out.utilPct = a.iGPUUtilPercent; // % passthrough (pinned)
        if (Number.isFinite(a.iTemperature)) out.tempC = a.iTemperature; // C passthrough (pinned)
        if (Number.isFinite(a.iPowerDraw) && a.iPowerDraw > 0) out.powerW = a.iPowerDraw / 1000; // mW -> W (pinned)
      }
    } catch { /* field omitted */ }
    // Fan: the RPM read requires the fan-control capability; a failed or
    // unsupported read stays absent (honest '-').
    if (state.fn.fan) {
      const speedBuf = koffi.alloc('int32', 1);
      const rpmBuf = koffi.alloc('int32', 1);
      try {
        if (state.fn.fan(state.adapterIndex, speedBuf, rpmBuf) === ADL_OK) {
          const rpmVal = koffi.decode(rpmBuf, 0, 'int32');
          if (Number.isFinite(rpmVal) && rpmVal > 0) out.fanRpm = [rpmVal];
        }
      } catch { /* field omitted */ }
    }
    return out;
  }

  function close() {
    if (state.initialized && state.fn?.destroy) {
      try { state.fn.destroy(); } catch { /* best effort */ }
    }
    state = { available: false, error: null, fn: null, initialized: false, adapterIndex: -1, count: 0, identity: null };
  }

  /**
   * M17d: the STATIC-INFO seam mirror - ADL exposes NO total-VRAM field and
   * no compute-core count, so both stay honest nulls (the no-Intel card's
   * VRAM row falls back to the OS controller bytes; the Compute row shows
   * the honest '-' on AMD). Never throws.
   * @returns {{ vramBytes: null, computeCores: null }}
   */
  function deviceInfo() {
    return { vramBytes: null, computeCores: null };
  }

  return {
    vendor: 'amd',
    get deviceIndex() { return state.adapterIndex >= 0 ? state.adapterIndex : (Number.isInteger(index) ? index : undefined); },
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
