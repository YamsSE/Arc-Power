// Arc Power - M4-D2 FPS adapter: DXGI GetFrameStatistics via koffi.
//
// Replaces the PresentMon wiring (the ETW metrics are unexported on this
// machine - dead code). DXGI is unelevated, system-wide and needs no
// service: CreateDXGIFactory1 (dxgi.dll export) → IDXGIFactory1 vtable →
// EnumAdapters1 → IDXGIAdapter vtable → EnumOutputs → IDXGIOutput vtable
// → GetFrameStatistics. The PresentCount delta of every output of every
// adapter is summed and divided by the wall-clock delta - the system-wide
// presented-frame count (covers the hybrid iGPU-present case).
//
// Pinned vtable slots (verified against the Windows SDK dxgi.idl layout /
// Microsoft's interface docs + Wine's dxgi implementation, 2026-08-07):
//   IDXGIFactory (0-6 IDXGIObject): 7 EnumAdapters, 8 MakeWindowAssociation,
//     9 GetWindowAssociation, 10 CreateSwapChain, 11 CreateSoftwareAdapter;
//     IDXGIFactory1: 12 EnumAdapters1, 13 IsCurrent;
//   IDXGIAdapter (0-6 IDXGIObject - inherits IDXGIObject DIRECTLY, no
//     IDXGIDeviceSubObject layer): 7 EnumOutputs, 8 GetDesc,
//     9 CheckInterfaceSupport; IDXGIAdapter1: 10 GetDesc1;
//   IDXGIOutput (0-6 IDXGIObject): 7 GetDesc, 8 GetDisplayModeList,
//     9 FindClosestMatchingMode, 10 WaitForVBlank, 11 TakeOwnership,
//     12 ReleaseOwnership, 13 GetGammaControlCapabilities, 14 SetGammaControl,
//     15 GetGammaControl, 16 SetDisplaySurface, 17 GetDisplaySurfaceData,
//     18 GetFrameStatistics. (12 methods - NO GetDevice, verified against
//     the Windows SDK dxgi.h layout + Microsoft's interface docs in run-1b.)
// The live "PresentCount sanity" checkpoint is the backstop: a wrong slot
// = garbage/crash - the probe MUST assert a plausible PresentCount.
//
// Semantics pinned (M4-D2 §11):
//   - the FIRST poll() takes the baseline (PresentCount deltas start at 0);
//   - DXGI_ERROR_FRAME_STATISTICS_DISCONTINUOUS (0x887A000B) re-baselines
//     that output - never '-', never a garbage jump;
//   - a zero PresentCount delta → honest 0 FPS (a static desktop - DWM
//     stops presenting; bitblt-presented windows never increment
//     PresentCount - documented in the report);
//   - LIVE FINDING (2026-08-07, this A770): IDXGIOutput::GetFrameStatistics
//     is "only supported while in full-screen mode" (Microsoft docs) - on
//     the windowed desktop it answers DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
//     (0x887A0001) and the counters never move. When NO output maintains
//     usable statistics, poll() returns null (honest '-', exactly like the
//     old PresentMon state) - NEVER a fake 0;
//   - DXGI unavailable (load/factory failure) → poll() returns null;
//   - poll() returns { fps, frameTimeMs: null, gpuBusy: null } - the same
//     shape as the old PresentMon adapter.
//
// The adapter also exposes adapterLuidOf(deviceIdHex): GetDesc1 carries the
// adapter LUID + DeviceId - the display-enumeration link that sys-stats.js
// uses to match the GPU-perf-counter instance names (the IGCL bindings
// expose no adapter LUID).
//
// FALLBACK (M4-D2 r2 amendment, implemented as run 1b): on a windowed
// desktop no output maintains GetFrameStatistics (every output answers
// DXGI_ERROR_NOT_CURRENTLY_AVAILABLE 0x887A0001 - the counters are only
// maintained in fullscreen mode). A pure-GFS path would honestly show '-'
// forever. When a poll finds NO output with usable GFS statistics, the poll
// falls back to IDXGIOutputDuplication frame counting (the OBS-style
// measure - counts DWM-presented frames per output, works windowed +
// borderless, unelevated, per-process duplication):
//   - IDXGIOutput1::DuplicateOutput - vtable slot 22 (CORRECTED live in
//     run 1b: the Windows SDK IDXGIOutput has 12 methods - GetDesc 7 …
//     GetFrameStatistics 18 - and NO GetDevice, so IDXGIOutput1 adds
//     GetDisplayModeList1 19, FindClosestMatchingMode1 20,
//     GetDisplaySurfaceData1 21, DuplicateOutput 22; slot 23 is
//     IDXGIOutput2::SupportsOverlays). Signature
//     (this, IUnknown* pDevice, IDXGIOutputDuplication**).
//   - pDevice MUST be a Direct3D device - the "NULL duplicates the whole
//     desktop" semantics belong to DuplicateOutput1 (IDXGIOutput5), NOT
//     DuplicateOutput (verified live: DuplicateOutput with NULL / the
//     factory / the output / an explicit-adapter device → E_INVALIDARG
//     0x80070057). The working recipe (verified live):
//     D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE=1, NULL, 0, NULL, 0,
//     D3D11_SDK_VERSION=7, &device, NULL, NULL) - the DEFAULT-adapter
//     device; a device created with an explicit adapter pointer is rejected
//     by DuplicateOutput. One device per session, shared by all outputs
//     (d3d11.dll is always present; the device never renders - it is only
//     the duplication handle).
//   - IDXGIOutputDuplication inherits IDXGIObject (0-6 - NOT IUnknown!):
//     GetDesc 7, AcquireNextFrame 8 ((this, UINT TimeoutInMilliseconds,
//     DXGI_OUTDUPL_FRAME_INFO*, IDXGIResource**)), GetFrameDirtyRects 9,
//     GetFrameMoveRects 10, GetFramePointerShape 11, MapDesktopSurface 12,
//     UnMapDesktopSurface 13, ReleaseFrame 14 ((this)). CORRECTED live in
//     run 1b (the plan's 4/10 assumed an IUnknown base).
//   - AcquireNextFrame with timeout 0; DXGI_ERROR_WAIT_TIMEOUT (0x887A0027)
//     ends the drain; on success → ReleaseFrame IMMEDIATELY (the next
//     AcquireNextFrame fails if the previous frame is not released).
//     DXGI_ERROR_ACCESS_LOST (0x887A0026) → drop the duplication object,
//     recreate it on the NEXT poll.
//   - COUNTING (corrected live in run 1b): the duplication COALESCES - the
//     operating system accumulates ALL desktop updates since the last
//     acquire into a SINGLE frame ("the operating system accumulates all
//     the desktop image updates into a single update" - IDXGIOutput-
//     Duplication docs). On this 180 Hz machine each 1.5 s poll returned
//     ONE acquired frame whose AccumulatedFrames field (DXGI_OUTDUPL_FRAME_
//     INFO@16, uint32) counted ~270 presented frames - counting acquires
//     alone would report 0.7 fps on a 180 fps desktop. The honest measure
//     is therefore the SUM of AccumulatedFrames over the drain
//     (Math.max(1, …) per acquired frame - the very first frame after
//     creation carries 0, but every acquired frame represents at least one
//     presented frame). Verified live: accum 91/0.5 s, 179/1 s, 269/1.5 s,
//     541/3 s - linear in the window at the 180 Hz refresh rate.
//   - DXGI_OUTDUPL_FRAME_INFO is a 48-byte buffer (the HRESULT + the
//     AccumulatedFrames@16 field are read); the resource out-ptr is a
//     'void*' buffer.
//   - Persistent per-output duplication objects, created lazily on the
//     FIRST poll that needs the fallback (multiple processes may duplicate
//     the same output); creation failures are retried on later polls.
//   - Each poll drains the frames since the last drain and divides by the
//     wall-clock Δt (the same baselineAt discipline as the GFS path - the
//     first fallback poll takes the baseline). The drain window always
//     matches the Δt window (the duplication queue accumulates exactly what
//     was presented since the last drain, including across GFS-active
//     polls), so mode flip-flops stay honest.
//   - GFS first; duplication ONLY when no GFS output answered. Both
//     unavailable → poll() returns null (honest '-'). Never throws.

import koffi from 'koffi';

// DXGI error codes (HRESULTs are compared unsigned).
export const DXGI_ERROR_NOT_FOUND = 0x887A0002;
export const DXGI_ERROR_FRAME_STATISTICS_DISCONTINUOUS = 0x887A000B;
export const DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = 0x887A0001;
export const DXGI_ERROR_WAIT_TIMEOUT = 0x887A0027;
export const DXGI_ERROR_ACCESS_LOST = 0x887A0026;

// IID_IDXGIFactory1 = {770aae78-f26f-4dba-a829-253c83d1b387} - little-endian
// GUID bytes (Data1/Data2/Data3 LE, Data4 verbatim).
export const IID_IDXGIFACTORY1_BYTES = [
  0x78, 0xae, 0x0a, 0x77, 0x6f, 0xf2, 0xba, 0x4d,
  0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87,
];

// DXGI_FRAME_STATISTICS: UINT PresentCount@0, UINT PresentRefreshCount@4,
// LARGE_INTEGER SyncRefreshCount@8, SyncQPCTime@16, SyncGPUTime@24 - 32 bytes.
export const DXGI_FRAME_STATISTICS_SIZE = 32;
export const FRAME_STATS_PRESENT_COUNT_OFF = 0;

// DXGI_OUTDUPL_FRAME_INFO: LARGE_INTEGER LastPresentTime@0,
// LARGE_INTEGER LastMouseUpdateTime@8, UINT AccumulatedFrames@16,
// BOOL RectsCoalesced@20, BOOL ProtectedContentMaskedOut@24,
// DXGI_OUTDUPL_POINTER_POSITION PointerPosition@28 (8 bytes),
// UINT TotalMetadataBufferSize@36, UINT PointerShapeBufferSize@40,
// pad@44 - 48 bytes. The fallback reads AccumulatedFrames@16 (uint32).
export const DXGI_OUTDUPL_FRAME_INFO_SIZE = 48;
export const OUTDUPL_ACCUMULATED_FRAMES_OFF = 16;

// DXGI_ADAPTER_DESC1: WCHAR Description[128]@0, UINT VendorId@256,
// UINT DeviceId@260, UINT SubSysId@264, UINT Revision@268,
// SIZE_T DedicatedVideoMemory@272, DedicatedSystemMemory@280,
// SharedSystemMemory@288, LUID AdapterLuid@296 (LowPart@296, HighPart@300),
// UINT Flags@304 - 308 bytes padded to 312 (8-alignment).
export const DXGI_ADAPTER_DESC1_SIZE = 312;
export const DESC1_DEVICE_ID_OFF = 260;
export const DESC1_LUID_LOW_OFF = 296;
export const DESC1_LUID_HIGH_OFF = 300;

// Function-pointer prototypes for the vtable slots (COM 'this' is the
// first explicit argument - x64 unifies the calling conventions).
const HR = koffi.proto('int32', ['void*', 'uint32', 'void**']); // (this, idx, out*)
const HR1 = koffi.proto('int32', ['void*', 'void*']); // (this, out*)
const REL = koffi.proto('uint32', ['void*']); // Release
const HR_DUP = koffi.proto('int32', ['void*', 'void*', 'void**']); // DuplicateOutput (this, pDevice, dup**)
const HR_ACQ = koffi.proto('int32', ['void*', 'uint32', 'void*', 'void**']); // AcquireNextFrame (this, timeout, frameInfo*, resource**)
const HR_O = koffi.proto('int32', ['void*']); // ReleaseFrame (this)

// Pinned slot indexes (see the header comment): EnumAdapters1 = 12,
// EnumOutputs = 7, GetDesc1 = 10, GetFrameStatistics = 18, Release = 2,
// DuplicateOutput = 22 (IDXGIOutput1), AcquireNextFrame = 8 +
// ReleaseFrame = 14 (IDXGIOutputDuplication, IDXGIObject-inherited).
const SLOT_RELEASE = 2;
const SLOT_ENUM_ADAPTERS1 = 12;
const SLOT_ENUM_OUTPUTS = 7;
const SLOT_GET_DESC1 = 10;
const SLOT_GET_FRAME_STATISTICS = 18;
const SLOT_DUPLICATE_OUTPUT = 22;
const SLOT_ACQUIRE_NEXT_FRAME = 8;
const SLOT_RELEASE_FRAME = 14;

// D3D11CreateDevice constants (the DuplicateOutput device recipe, live-
// verified): D3D_DRIVER_TYPE_HARDWARE = 1 (with pAdapter = NULL - the
// default adapter), D3D11_SDK_VERSION = 7.
const D3D_DRIVER_TYPE_HARDWARE = 1;
const D3D11_SDK_VERSION = 7;

/**
 * Call one COM vtable slot. The object is a pointer to a COM object whose
 * first member is the vtable pointer; the slot's raw pointer is read and
 * invoked via koffi.call (the documented function-pointer call API - a
 * directly-decoded proto is NOT callable on this koffi version, verified
 * live: direct invocation of a decoded slot AVs the process).
 * Exported so the live probe can wrap it (deps.callSlot) to log the
 * DuplicateOutput creation HRESULTs per output.
 * @param {object} objPtr koffi pointer value of the COM object
 * @param {number} slot the vtable slot index
 * @param {object} proto the koffi proto type for the slot's signature
 * @param {...unknown} args the call arguments (this first)
 */
export function defaultCallSlot(objPtr, slot, proto, ...args) {
  const vtblPtr = koffi.decode(objPtr, 0, 'void*');
  const slotPtr = koffi.decode(vtblPtr, slot * 8, 'void*');
  return koffi.call(slotPtr, proto, ...args);
}

/**
 * Read the DXGI_FRAME_STATISTICS.PresentCount (uint32 at offset 0).
 * @param {object} statsBuf koffi buffer
 * @returns {number}
 */
export function presentCountOf(statsBuf) {
  return koffi.decode(statsBuf, FRAME_STATS_PRESENT_COUNT_OFF, 'uint32');
}

/**
 * uint32 wrap-aware delta: the counters wrap at 2^32 (a >4e9 present
 * count would otherwise render a huge negative delta).
 * @param {number} curr
 * @param {number} base
 * @returns {number}
 */
export function wrappedDelta(curr, base) {
  return ((curr - base) + 0x100000000) % 0x100000000;
}

/**
 * The DXGI FPS adapter + the adapter-LUID link. Interface (mirrors the old
 * PresentMon adapter): poll(deviceId) → sample|null, stop(), and the
 * M4-D2 addition adapterLuidOf(deviceIdHex) for sys-stats.
 * Graceful degradation: a load/factory/enumeration failure leaves
 * available=false and poll() returns null forever - never throws.
 * @param {{
 *   load?: (name: string) => object,   // injectable koffi load (tests)
 *   now?: () => number,                // injectable wall clock (ms)
 *   callSlot?: Function,               // injectable vtable-slot caller (tests/probe)
 * }} [deps]
 */
export function createDxgiFpsAdapter(deps = {}) {
  const load = deps.load ?? ((name) => koffi.load(name));
  const now = deps.now ?? (() => Date.now());
  // Testability seam: the tests inject a fake slot caller that scripts the
  // HRESULTs (a real vtable call cannot be faked in-process - koffi.call on
  // a fake pointer would crash). The live probe wraps the real one to log
  // the DuplicateOutput creation results.
  const slotFn = deps.callSlot ?? defaultCallSlot;

  let available = false;
  let availableReason = null;
  let factory = null;
  let outputs = []; // [{ ptr, vtbl }]
  let adapters = []; // [{ ptr, vtbl, deviceId }]
  let luidCache = new Map(); // deviceIdHex -> { high, low } | null
  let baselineAt = null;
  let baselinePresent = new Map(); // output ptr -> PresentCount baseline
  let dupDevice = null; // the session D3D11 device (DuplicateOutput's pDevice)
  let dupDeviceFailed = false;
  let dupObjects = new Map(); // output ptr -> IDXGIOutputDuplication ptr
  let dupBaselineAt = null; // the fallback path's own baseline (ms)

  const init = () => {
    if (factory !== null) return true;
    try {
      const lib = load('dxgi.dll');
      const createFactory = lib.func('CreateDXGIFactory1', 'int32', ['void*', 'void**']);
      const riid = koffi.alloc('uint8', 16);
      for (let i = 0; i < 16; i++) koffi.encode(riid, i, 'uint8', IID_IDXGIFACTORY1_BYTES[i]);
      const factoryBuf = koffi.alloc('void*', 1);
      const hr = createFactory(riid, factoryBuf);
      if ((hr >>> 0) !== 0) {
        availableReason = `CreateDXGIFactory1 failed (0x${(hr >>> 0).toString(16)})`;
        return false;
      }
      factory = koffi.decode(factoryBuf, 0, 'void*');
      // Enumerate adapters (IDXGIFactory1.EnumAdapters1 = slot 12) + their
      // outputs (IDXGIAdapter.EnumOutputs = slot 7). Hold the refs for the
      // session; released in stop().
      const adapterBuf = koffi.alloc('void*', 1);
      for (let idx = 0; ; idx++) {
        koffi.encode(adapterBuf, 'void*', 0);
        const hrEnum = slotFn(factory, SLOT_ENUM_ADAPTERS1, HR, factory, idx, adapterBuf);
        if ((hrEnum >>> 0) === DXGI_ERROR_NOT_FOUND) break;
        if (hrEnum < 0) break;
        const adapter = koffi.decode(adapterBuf, 0, 'void*');
        const desc1 = koffi.alloc('uint8', DXGI_ADAPTER_DESC1_SIZE);
        let deviceId = null;
        try {
          const hrDesc = slotFn(adapter, SLOT_GET_DESC1, HR1, adapter, desc1);
          if (hrDesc >= 0) {
            deviceId = koffi.decode(desc1, DESC1_DEVICE_ID_OFF, 'uint32');
          }
        } catch { /* GetDesc1 best effort - the LUID link degrades */ }
        const outputBuf = koffi.alloc('void*', 1);
        for (let oidx = 0; ; oidx++) {
          koffi.encode(outputBuf, 'void*', 0);
          const hrOut = slotFn(adapter, SLOT_ENUM_OUTPUTS, HR, adapter, oidx, outputBuf);
          if ((hrOut >>> 0) === DXGI_ERROR_NOT_FOUND) break;
          if (hrOut < 0) break;
          outputs.push(koffi.decode(outputBuf, 0, 'void*'));
        }
        adapters.push({ ptr: adapter, deviceId });
      }
      if (adapters.length === 0) {
        availableReason = 'no DXGI adapters enumerated';
        return false;
      }
      available = true;
      return true;
    } catch (err) {
      availableReason = `DXGI init failed: ${err.message}`;
      return false;
    }
  };

  // --- Duplication fallback (M4-D2 r2 amendment) -------------------------
  // The DuplicateOutput pDevice: one D3D11 device per session, created via
  // D3D11CreateDevice(NULL, HARDWARE, …) - the DEFAULT-adapter device.
  // Live-verified in run 1b: (a) DuplicateOutput REJECTS a device created
  // with an explicit adapter pointer (E_INVALIDARG) but accepts the
  // default-adapter device; (b) NULL is NOT accepted (the "NULL = whole
  // desktop" semantics belong to DuplicateOutput1, not DuplicateOutput).
  // Failure is permanent (d3d11.dll missing = the fallback is impossible).
  const ensureDupDevice = () => {
    if (dupDevice !== null || dupDeviceFailed) return dupDevice;
    try {
      const lib11 = load('d3d11.dll');
      const createDevice = lib11.func('D3D11CreateDevice', 'int32', [
        'void*',   // pAdapter (NULL = default adapter)
        'int32',   // DriverType = D3D_DRIVER_TYPE_HARDWARE
        'void*',   // Software (NULL)
        'uint32',  // Flags (0)
        'void*',   // pFeatureLevels (NULL = default list)
        'uint32',  // FeatureLevels (0)
        'uint32',  // SDKVersion = D3D11_SDK_VERSION
        'void**',  // ppDevice
        'void*',   // pFeatureLevel (NULL)
        'void**',  // ppImmediateContext (NULL)
      ]);
      const deviceBuf = koffi.alloc('void*', 1);
      const hr = createDevice(null, D3D_DRIVER_TYPE_HARDWARE, null, 0, null, 0, D3D11_SDK_VERSION, deviceBuf, null, null);
      if ((hr >>> 0) !== 0) {
        dupDeviceFailed = true;
        return null;
      }
      dupDevice = koffi.decode(deviceBuf, 0, 'void*');
    } catch {
      dupDeviceFailed = true;
    }
    return dupDevice;
  };

  // Lazily create the per-output IDXGIOutputDuplication objects on the
  // FIRST poll that needs the fallback. Creation is per-process allowed
  // (multiple processes may duplicate the same output; Windows caps
  // concurrent duplications at 4 processes per session); failures are
  // retried on later polls. Returns whether any object was created this
  // call (a creation poll is always a baseline poll - fresh objects have
  // empty queues).
  const ensureDuplications = (device) => {
    let createdAny = false;
    for (const output of outputs) {
      if (dupObjects.has(output)) continue;
      const dupBuf = koffi.alloc('void*', 1);
      try {
        const hr = slotFn(output, SLOT_DUPLICATE_OUTPUT, HR_DUP, output, device, dupBuf);
        if ((hr >>> 0) === 0) {
          dupObjects.set(output, koffi.decode(dupBuf, 0, 'void*'));
          createdAny = true;
        }
      } catch { /* creation failed - retried on the next poll */ }
    }
    return createdAny;
  };

  const dropDuplication = (output) => {
    const dup = dupObjects.get(output);
    if (dup !== undefined) {
      try { slotFn(dup, SLOT_RELEASE, REL, dup); } catch { /* best effort */ }
      dupObjects.delete(output);
    }
  };

  // Drain the duplication queues and divide by the wall-clock Δt. Called
  // ONLY when no output answered GetFrameStatistics. The queue accumulates
  // exactly what was presented since the last drain (including across
  // GFS-active polls), so the count window always matches the Δt window.
  // Returns null when no duplication exists at all (both paths
  // unavailable - honest '-'); never throws.
  const pollViaDuplication = (at) => {
    const device = ensureDupDevice();
    if (!device) return null; // d3d11 unavailable → duplication impossible
    const createdAny = ensureDuplications(device);
    if (dupObjects.size === 0) return null; // GFS + duplication both unavailable
    if (createdAny || dupBaselineAt === null) {
      // baseline poll: fresh objects have empty queues - nothing to drain
      dupBaselineAt = at;
      return { fps: 0, frameTimeMs: null, gpuBusy: null };
    }
    let frameCount = 0;
    const frameInfo = koffi.alloc('uint8', DXGI_OUTDUPL_FRAME_INFO_SIZE);
    const resource = koffi.alloc('void*', 1);
    for (const [output, dup] of dupObjects) {
      for (;;) {
        let hr;
        try {
          hr = slotFn(dup, SLOT_ACQUIRE_NEXT_FRAME, HR_ACQ, dup, 0, frameInfo, resource);
        } catch { break; } // defensive - never throw out of poll()
        const hrU = hr >>> 0;
        if (hrU === 0) {
          // The duplication COALESCES: each acquired frame carries the
          // number of presented frames accumulated since the last acquire
          // in DXGI_OUTDUPL_FRAME_INFO.AccumulatedFrames@16 (live-verified
          // on the 180 Hz desktop: ~270 per 1.5 s poll in ONE frame). The
          // honest present count is the SUM - with a floor of 1 per
          // acquired frame (the very first frame after creation carries 0).
          let accum = 0;
          try { accum = koffi.decode(frameInfo, OUTDUPL_ACCUMULATED_FRAMES_OFF, 'uint32'); } catch { /* defensive */ }
          frameCount += Math.max(1, accum);
          // NEVER skip the ReleaseFrame - the next AcquireNextFrame fails
          // if the previous frame is not released.
          try { slotFn(dup, SLOT_RELEASE_FRAME, HR_O, dup); } catch { break; }
          continue;
        }
        if (hrU === DXGI_ERROR_WAIT_TIMEOUT) break; // queue drained
        if (hrU === DXGI_ERROR_ACCESS_LOST) {
          dropDuplication(output); // recreate on the NEXT poll
          break;
        }
        break; // any other error ends this output's drain
      }
    }
    const dtSec = (at - dupBaselineAt) / 1000;
    dupBaselineAt = at;
    if (dtSec <= 0) return { fps: 0, frameTimeMs: null, gpuBusy: null };
    const fps = frameCount / dtSec;
    // Honest 0 for a static desktop (DWM stops presenting) - never '-'.
    return { fps: Math.round(fps * 10) / 10, frameTimeMs: null, gpuBusy: null };
  };

  return {
    get available() {
      return available;
    },
    get availableReason() {
      return availableReason;
    },
    /**
     * Resolve the adapter LUID for a PCI device id (the display-
     * enumeration link for sys-stats gpuMemUsedBytes). Cached per device
     * id; null when no adapter matches. Never throws.
     * @param {string} deviceIdHex e.g. '0x56a0'
     * @returns {Promise<{ high: number, low: number } | null>}
     */
    async adapterLuidOf(deviceIdHex) {
      if (!init()) return null;
      if (luidCache.has(deviceIdHex)) return luidCache.get(deviceIdHex);
      let found = null;
      try {
        const want = typeof deviceIdHex === 'string'
          ? Number.parseInt(deviceIdHex.replace(/^0x/i, ''), 16)
          : NaN;
        for (const adapter of adapters) {
          if (adapter.deviceId !== null && Number.isFinite(want) && adapter.deviceId === want) {
            const desc1 = koffi.alloc('uint8', DXGI_ADAPTER_DESC1_SIZE);
            const hrDesc = slotFn(adapter.ptr, SLOT_GET_DESC1, HR1, adapter.ptr, desc1);
            if (hrDesc >= 0) {
              found = {
                low: koffi.decode(desc1, DESC1_LUID_LOW_OFF, 'uint32'),
                high: koffi.decode(desc1, DESC1_LUID_HIGH_OFF, 'int32'),
              };
            }
            break;
          }
        }
      } catch {
        found = null;
      }
      luidCache.set(deviceIdHex, found);
      return found;
    },

    /**
     * System-wide FPS via GetFrameStatistics. The FIRST call takes the
     * baseline (PresentCount deltas start at 0 - an honest 0 FPS sample,
     * never '-'). Later calls: sum the wrap-aware PresentCount deltas of
     * every output / wall-clock Δt; a DISCONTINUOUS answer re-baselines
     * that output. DXGI unavailable → null.
     * @param {number} _deviceId (ignored - system-wide)
     * @returns {Promise<{ fps: number | null, frameTimeMs: null, gpuBusy: null } | null>}
     */
    async poll(_deviceId) {
      if (!init()) return null;
      const at = now();
      try {
        let presentSum = 0;
        let anyOk = false;
        for (const output of outputs) {
          const stats = koffi.alloc('uint8', DXGI_FRAME_STATISTICS_SIZE);
          const hr = slotFn(output, SLOT_GET_FRAME_STATISTICS, HR1, output, stats);
          if ((hr >>> 0) === DXGI_ERROR_FRAME_STATISTICS_DISCONTINUOUS) {
            // re-baseline this output - never a garbage jump, never '-'
            anyOk = true;
            baselinePresent.set(output, presentCountOf(stats));
            continue;
          }
          if (hr < 0) continue; // NOT_CURRENTLY_AVAILABLE / other - no stats
          anyOk = true;
          const count = presentCountOf(stats);
          const base = baselinePresent.has(output) ? baselinePresent.get(output) : null;
          if (base === null) {
            baselinePresent.set(output, count);
            continue;
          }
          baselinePresent.set(output, count);
          presentSum += wrappedDelta(count, base);
        }
        if (!anyOk) {
          // No output maintains usable frame statistics (live on this
          // machine: the windowed desktop answers NOT_CURRENTLY_AVAILABLE -
          // GetFrameStatistics is only supported in fullscreen mode).
          // FALLBACK (r2 amendment): count DWM-presented frames via
          // IDXGIOutputDuplication - the OBS-style measure that works
          // windowed + borderless, unelevated. GFS first; duplication ONLY
          // when no GFS output answered. Both unavailable → null (honest
          // '-', never a fake 0).
          return pollViaDuplication(at);
        }
        if (baselineAt === null) {
          // first poll: baseline only - the delta starts at 0
          baselineAt = at;
          return { fps: 0, frameTimeMs: null, gpuBusy: null };
        }
        const dtSec = (at - baselineAt) / 1000;
        baselineAt = at;
        if (dtSec <= 0) return { fps: 0, frameTimeMs: null, gpuBusy: null };
        const fps = presentSum / dtSec;
        // Honest 0 for a static desktop (DWM stops presenting) - never '-'.
        return { fps: Math.round(fps * 10) / 10, frameTimeMs: null, gpuBusy: null };
      } catch {
        return null;
      }
    },

    async stop() {
      try {
        for (const [output, dup] of dupObjects) {
          try { slotFn(dup, SLOT_RELEASE, REL, dup); } catch { /* best effort */ }
        }
        dupObjects = new Map();
        dupBaselineAt = null;
        if (dupDevice) {
          try { slotFn(dupDevice, SLOT_RELEASE, REL, dupDevice); } catch { /* best effort */ }
          dupDevice = null;
        }
        dupDeviceFailed = false;
        for (const output of outputs) {
          try { slotFn(output, SLOT_RELEASE, REL, output); } catch { /* best effort */ }
        }
        outputs = [];
        for (const adapter of adapters) {
          try { slotFn(adapter.ptr, SLOT_RELEASE, REL, adapter.ptr); } catch { /* best effort */ }
        }
        adapters = [];
        if (factory) {
          try { slotFn(factory, SLOT_RELEASE, REL, factory); } catch { /* best effort */ }
          factory = null;
        }
      } catch { /* best effort */ }
      baselineAt = null;
      baselinePresent = new Map();
    },
  };
}
