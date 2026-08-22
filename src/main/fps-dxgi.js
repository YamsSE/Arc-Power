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
// M7a (the 1% Low / 99% FPS stats): the adapter is reworked into a
// SINGLE-READER SAMPLER. A 200 ms internal interval (started lazily on the
// FIRST poll() call, cleared in stop()) owns EVERY counter read - the
// per-output GetFrameStatistics with its own baseline map, or - when no
// GFS output answers (the live windowed-desktop case) - the
// IDXGIOutputDuplication drain (its own baseline; the sampler is the ONLY
// duplication drainer, so the queue is never double-drained). Each tick
// with frames > 0 and dt > 0 pushes { tMs, ftMs: dtMs / frames, frames }
// into a ring (~300 entries / 60 s window - the M14 amendment: the ring
// holds a full 60 s at the 200 ms sampler cadence; the pure fps-percentiles
// module owns the math). poll() never reads the counters itself anymore - it
// derives the sample from the ring:
//   - fps = the frames summed over the ring entries within the last 1 s
//     window (the same presentSum/dt semantics as the old 1 s cadence;
//     rounded to 1 decimal; an empty ring honestly reads 0 - the
//     static-desktop shape, never '-');
//   - avgFps / low1Pct / low01Pct / p99 from percentileStats (null until
//     the 60-frame floor - the honest degrade; low01Pct additionally needs
//     the >= 300-frame floor (M13); a static desktop pushes nothing, so after
//     the window elapses the ring is empty and the percentiles return
//     null, never stale values).
//   Return shape: { fps, avgFps, low1Pct, low01Pct, p99, frameTimeMs:
//     null, gpuBusy: null }.
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
// Semantics pinned (M4-D2 §11, carried into the sampler):
//   - the FIRST tick takes the baseline (PresentCount deltas start at 0);
//   - DXGI_ERROR_FRAME_STATISTICS_DISCONTINUOUS (0x887A000B) re-baselines
//     that output - never '-', never a garbage jump;
//   - a zero PresentCount delta → a tick with frames 0 pushes nothing (a
//     static desktop - DWM stops presenting; bitblt-presented windows
//     never increment PresentCount - documented in the report) and the
//     poll reads 0 fps + null percentiles;
//   - LIVE FINDING (2026-08-07, this A770): IDXGIOutput::GetFrameStatistics
//     is "only supported while in full-screen mode" (Microsoft docs) - on
//     the windowed desktop it answers DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
//     (0x887A0001) and the counters never move. The sampler falls back to
//     the duplication drain (below) per tick;
//   - DXGI unavailable (load/factory failure) → poll() returns null.
//
// The adapter also exposes adapterLuidOf(deviceIdHex, bdf): GetDesc1 carries
// the adapter LUID + DeviceId - the display-enumeration link that sys-stats.js
// uses to match the GPU-perf-counter instance names (the IGCL bindings expose
// no adapter LUID). M30: duplicate PCI device IDs are disambiguated with the
// adapter's D3DKMT-reported PCI/BDF address, not enumeration order.
//
// FALLBACK (M4-D2 r2 amendment, implemented as run 1b; folded into the
// sampler by M7a): on a windowed desktop no output maintains
// GetFrameStatistics (every output answers DXGI_ERROR_NOT_CURRENTLY_AVAILABLE
// 0x887A0001 - the counters are only maintained in fullscreen mode). A
// pure-GFS path would honestly show '-' forever. When a tick finds NO
// output with usable GFS statistics, the tick falls back to
// IDXGIOutputDuplication frame counting (the OBS-style measure - counts
// DWM-presented frames per output, works windowed + borderless, unelevated,
// per-process duplication):
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
//     recreate it on the NEXT tick.
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
//     FIRST tick that needs the fallback (multiple processes may duplicate
//     the same output); creation failures are retried on later ticks.
//   - Each tick drains the frames since the last drain and divides by the
//     wall-clock Δt (the same baselineAt discipline as the GFS path - the
//     first fallback tick takes the baseline). The drain window always
//     matches the Δt window (the duplication queue accumulates exactly what
//     was presented since the last drain, including across GFS-active
//     ticks), so mode flip-flops stay honest.
//   - GFS first; duplication ONLY when no GFS output answered. Both
//     unavailable → the tick pushes nothing and the poll honestly reads
//     fps 0 + null percentiles (the ring cannot distinguish a dead path
//     from a static desktop; the overlay renders '-' for both anyway).
//     Never throws.

import koffi from 'koffi';
import { pushRing, rollingFps, percentileStats, RING_MAX, PERCENTILE_WINDOW_MS, AVG_WINDOW_MS } from './fps-percentiles.js';

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
// D3DKMT adapter-address bridge (gdi32.dll). The KMT enum value is the
// documented KMTQAITYPE_ADAPTERADDRESS member (6); all calls are optional and
// fail closed when WDDM/GDI does not expose the bridge.
const KMTQAITYPE_ADAPTERADDRESS = 6;
const D3DKMT_OPENADAPTERFROMLUID_SIZE = 12; // LUID (8) + UINT handle
const D3DKMT_QUERYADAPTERINFO_SIZE = 24; // handle + enum + pointer + UINT
const D3DKMT_CLOSEADAPTER_SIZE = 4;
const D3DKMT_ADAPTERADDRESS_SIZE = 12;

// M7a: the sampler cadence (the ring's 200 ms entries) + the poll's fps
// rolling window.
// M17b (2d-1, the GFS-borderless probe verdict - pipeline/
// live-fps-accuracy.mjs, 2026-08-11): GetFrameStatistics does NOT answer
// for a borderless-fullscreen window (14/14 DXGI_ERROR_NOT_CURRENTLY_
// AVAILABLE with a real frameless-maximized window on the output - the
// "fullscreen-only" claim holds: GFS maintains its counters only in
// EXCLUSIVE fullscreen). The duplication path is therefore the display
// rate source on windowed/borderless programs, and the displayed fps is
// REFRESH-BOUND there by design (documented in the overlay Notes card).
// The old 1 s rolling sum was a 1 s-lagged average by construction; the
// M17b fallback TIGHTENS the displayed window to 500 ms (2-3 ticks at
// the 200 ms cadence - the plan's 400-600 ms range) so the reading
// tracks the game's rate changes far closer. The poll divides the
// window's frame sum by the window IN SECONDS (a 500 ms window summing
// 90 frames on the 180 Hz desktop must read 180, never 90 - the frame
// count is linear in the window, the rate is not).
const SAMPLER_INTERVAL_MS = 200;
const FPS_WINDOW_MS = 500;

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
 * Resolve a DXGI adapter LUID to the physical PCI/BDF address through the
 * documented D3DKMT bridge. The bridge is deliberately best-effort: a
 * missing export, unsupported WDDM query, or malformed result returns null
 * and duplicate device IDs remain fail-closed.
 * @param {(name: string) => object} load
 * @returns {(low: number, high: number) => string|null}
 */
function createAdapterBdfResolver(load) {
  let open;
  let query;
  let close;
  try {
    const gdi = load('gdi32.dll');
    open = gdi.func('D3DKMTOpenAdapterFromLuid', 'int32', ['void*']);
    query = gdi.func('D3DKMTQueryAdapterInfo', 'int32', ['void*']);
    close = gdi.func('D3DKMTCloseAdapter', 'int32', ['void*']);
  } catch {
    return () => null;
  }
  return (low, high) => {
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
    const openBuf = koffi.alloc('uint8', D3DKMT_OPENADAPTERFROMLUID_SIZE);
    const queryBuf = koffi.alloc('uint8', D3DKMT_QUERYADAPTERINFO_SIZE);
    const addressBuf = koffi.alloc('uint8', D3DKMT_ADAPTERADDRESS_SIZE);
    const closeBuf = koffi.alloc('uint8', D3DKMT_CLOSEADAPTER_SIZE);
    try {
      koffi.encode(openBuf, 0, 'uint32', low >>> 0);
      koffi.encode(openBuf, 4, 'int32', high | 0);
      koffi.encode(openBuf, 8, 'uint32', 0);
      if (open(openBuf) !== 0) return null;
      const handle = koffi.decode(openBuf, 8, 'uint32');
      try {
        koffi.encode(queryBuf, 0, 'uint32', handle);
        koffi.encode(queryBuf, 4, 'uint32', KMTQAITYPE_ADAPTERADDRESS);
        koffi.encode(queryBuf, 8, 'void*', koffi.address(addressBuf));
        koffi.encode(queryBuf, 16, 'uint32', D3DKMT_ADAPTERADDRESS_SIZE);
        if (query(queryBuf) !== 0) return null;
        const bus = koffi.decode(addressBuf, 0, 'uint32');
        const device = koffi.decode(addressBuf, 4, 'uint32');
        const fn = koffi.decode(addressBuf, 8, 'uint32');
        if (![bus, device, fn].every(Number.isInteger) || bus > 0xff || device > 0x1f || fn > 7) return null;
        return `0000:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
      } finally {
        koffi.encode(closeBuf, 0, 'uint32', handle);
        try { close(closeBuf); } catch { /* best effort */ }
      }
    } catch {
      return null;
    }
  };
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
 * COUNTER-RESET EDGE: a PresentCount RESET without the DISCONTINUOUS flag
 * violates the DXGI contract (DISCONTINUOUS is the documented reset
 * signal) and yields a delta near 2^32 for one tick - the percentile
 * expansion clamp (MAX_FRAMES_PER_ENTRY in fps-percentiles.js) bounds the
 * blast radius; an honest stream never sees this.
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
 * M7a/M12: poll() no longer reads the counters itself - the internal
 * 200 ms sampler does (started lazily on the FIRST poll, cleared in
 * stop()); the poll derives { fps, avgFps, low1Pct, low01Pct, p99 } from
 * the ring the sampler maintains.
 * Graceful degradation: a load/factory/enumeration failure leaves
 * available=false and poll() returns null forever - never throws.
 * @param {{
 *   load?: (name: string) => object,   // injectable koffi load (tests)
 *   now?: () => number,                // injectable wall clock (ms)
 *   callSlot?: Function,               // injectable vtable-slot caller (tests/probe)
 *   adapterBdfOf?: (low: number, high: number) => string|null, // BDF seam
 *   setInterval?: (fn: () => void, ms: number) => unknown,  // injectable sampler timer (tests)
 *   clearInterval?: (id: unknown) => void,                  // injectable sampler timer (tests)
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
  // M7a: the sampler timer seam - the tests inject a fake interval and tick
  // the sampler deterministically (no real 200 ms wall-clock dependency).
  const setSamplerTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearSamplerTimer = deps.clearInterval ?? ((id) => clearInterval(id));

  let available = false;
  let availableReason = null;
  let factory = null;
  let outputs = []; // [{ ptr, vtbl }]
  let adapters = []; // [{ ptr, vtbl, deviceId, bdf }]
  let luidCache = new Map(); // deviceIdHex|bdf -> { high, low } | null
  let baselineAt = null; // the GFS path's own baseline (ms)
  let baselinePresent = new Map(); // output ptr -> PresentCount baseline
  let dupDevice = null; // the session D3D11 device (DuplicateOutput's pDevice)
  let dupDeviceFailed = false;
  let dupObjects = new Map(); // output ptr -> IDXGIOutputDuplication ptr
  let dupBaselineAt = null; // the fallback path's own baseline (ms)
  // M7a: the sampler state - the ring of { tMs, ftMs, frames } entries
  // (max ~300 / 60 s - the M14 amendment: a full 60 s at the 200 ms
  // sampler cadence; the pure fps-percentiles constants) + the interval
  // id (null until the first poll starts the sampler).
  let ring = [];
  let samplerTimer = null;

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
      const resolveAdapterBdf = deps.adapterBdfOf ?? createAdapterBdfResolver(load);
      for (let idx = 0; ; idx++) {
        koffi.encode(adapterBuf, 'void*', 0);
        const hrEnum = slotFn(factory, SLOT_ENUM_ADAPTERS1, HR, factory, idx, adapterBuf);
        if ((hrEnum >>> 0) === DXGI_ERROR_NOT_FOUND) break;
        if (hrEnum < 0) break;
        const adapter = koffi.decode(adapterBuf, 0, 'void*');
        const desc1 = koffi.alloc('uint8', DXGI_ADAPTER_DESC1_SIZE);
        let deviceId = null;
        let adapterBdf = null;
        try {
          const hrDesc = slotFn(adapter, SLOT_GET_DESC1, HR1, adapter, desc1);
          if (hrDesc >= 0) {
            deviceId = koffi.decode(desc1, DESC1_DEVICE_ID_OFF, 'uint32');
            adapterBdf = resolveAdapterBdf(
              koffi.decode(desc1, DESC1_LUID_LOW_OFF, 'uint32'),
              koffi.decode(desc1, DESC1_LUID_HIGH_OFF, 'int32'),
            );
          }
        } catch { /* GetDesc1 best effort - the LUID/BDF link degrades */ }
        const outputBuf = koffi.alloc('void*', 1);
        for (let oidx = 0; ; oidx++) {
          koffi.encode(outputBuf, 'void*', 0);
          const hrOut = slotFn(adapter, SLOT_ENUM_OUTPUTS, HR, adapter, oidx, outputBuf);
          if ((hrOut >>> 0) === DXGI_ERROR_NOT_FOUND) break;
          if (hrOut < 0) break;
          outputs.push(koffi.decode(outputBuf, 0, 'void*'));
        }
        adapters.push({ ptr: adapter, deviceId, bdf: adapterBdf });
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
  // FIRST tick that needs the fallback. Creation is per-process allowed
  // (multiple processes may duplicate the same output; Windows caps
  // concurrent duplications at 4 processes per session); failures are
  // retried on later ticks. Returns whether any object was created this
  // call (a creation tick is always a baseline tick - fresh objects have
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
      } catch { /* creation failed - retried on the next tick */ }
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

  // M7a: ONE GFS read pass - the per-output PresentCount deltas since the
  // last tick. The DISCONTINUOUS re-baseline (M4-D2 §11) survives: a
  // DISCONTINUOUS answer re-baselines that output - never '-', never a
  // garbage jump. Returns null when NO output answered (the duplication
  // fallback takes over); { frames, dtMs } otherwise (a baseline tick
  // reads frames 0 / dtMs 0 - nothing gets pushed).
  const readGfsTick = (at) => {
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
    if (!anyOk) return null;
    if (baselineAt === null) {
      // the first GFS tick: baseline only - the delta starts at 0
      baselineAt = at;
      return { frames: 0, dtMs: 0 };
    }
    const dtMs = at - baselineAt;
    baselineAt = at;
    if (dtMs <= 0) return { frames: 0, dtMs: 0 };
    return { frames: presentSum, dtMs };
  };

  // M7a: the duplication drain folded into the sampler (the sampler is the
  // ONLY drainer now - the queue is never double-drained by a poll). The
  // queue accumulates exactly what was presented since the last drain
  // (including across GFS-active ticks), so the count window always
  // matches the Δt window. Returns null when no duplication exists at all;
  // { frames, dtMs } otherwise (a baseline tick reads frames 0 / dtMs 0).
  const readDuplicationTick = (at) => {
    const device = ensureDupDevice();
    if (!device) return null; // d3d11 unavailable → duplication impossible
    const createdAny = ensureDuplications(device);
    if (dupObjects.size === 0) return null; // GFS + duplication both unavailable
    if (createdAny || dupBaselineAt === null) {
      // baseline tick: fresh objects have empty queues - nothing to drain
      dupBaselineAt = at;
      return { frames: 0, dtMs: 0 };
    }
    let frameCount = 0;
    const frameInfo = koffi.alloc('uint8', DXGI_OUTDUPL_FRAME_INFO_SIZE);
    const resource = koffi.alloc('void*', 1);
    for (const [output, dup] of dupObjects) {
      for (;;) {
        let hr;
        try {
          hr = slotFn(dup, SLOT_ACQUIRE_NEXT_FRAME, HR_ACQ, dup, 0, frameInfo, resource);
        } catch { break; } // defensive - never throw out of the tick
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
          dropDuplication(output); // recreate on the NEXT tick
          break;
        }
        break; // any other error ends this output's drain
      }
    }
    const dtMs = at - dupBaselineAt;
    dupBaselineAt = at;
    if (dtMs <= 0) return { frames: 0, dtMs: 0 };
    return { frames: frameCount, dtMs };
  };

  // M7a: ONE sampler tick - the ONLY counter read in the adapter. The
  // 200 ms interval owns every GetFrameStatistics + duplication drain;
  // poll() only reads the ring. A tick NEVER throws (defensive - a failed
  // tick pushes nothing). A tick with frames > 0 and dt > 0 pushes one
  // ring entry; zero frames (a static desktop) pushes nothing so the ring
  // decays and the percentiles honestly return null.
  const sampleTick = () => {
    try {
      const at = now();
      // Age-evict the ring first (the SAME recency window the percentile
      // math uses - stale entries never linger in the ring).
      ring = ring.filter((e) => e.tMs >= at - PERCENTILE_WINDOW_MS);
      const read = readGfsTick(at);
      const tick = read !== null ? read : readDuplicationTick(at);
      if (tick === null) return; // both paths unavailable - push nothing
      if (!(tick.frames > 0) || !(tick.dtMs > 0)) return;
      pushRing(ring, { tMs: at, ftMs: tick.dtMs / tick.frames, frames: tick.frames }, RING_MAX);
    } catch { /* defensive - a tick never throws */ }
  };

  // M7a: the sampler lifecycle - started LAZILY on the first poll() call
  // (no counter reads before anything asks for FPS), cleared in stop().
  const ensureSampler = () => {
    if (samplerTimer !== null) return;
    samplerTimer = setSamplerTimer(sampleTick, SAMPLER_INTERVAL_MS);
  };

  const stopSampler = () => {
    if (samplerTimer !== null) {
      try { clearSamplerTimer(samplerTimer); } catch { /* best effort */ }
      samplerTimer = null;
    }
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
    async adapterLuidOf(deviceIdHex, bdf = null) {
      if (!init()) return null;
      const cacheKey = `${String(deviceIdHex ?? '')}|${String(bdf ?? '')}`;
      if (luidCache.has(cacheKey)) return luidCache.get(cacheKey);
      let found = null;
      try {
        const want = typeof deviceIdHex === 'string'
          ? Number.parseInt(deviceIdHex.replace(/^0x/i, ''), 16)
          : NaN;
        const candidates = adapters.filter((adapter) => adapter.deviceId !== null
          && Number.isFinite(want) && adapter.deviceId === want);
        // A PCI device id alone is not a durable bridge when same-model
        // adapters are present. A BDF bridge may select a provider-enriched
        // adapter; otherwise degrade to null rather than alias adapter 0.
        const selected = candidates.length === 1
          ? candidates[0]
          : candidates.find((adapter) => bdf && adapter.bdf === bdf) ?? null;
        if (selected) {
          const desc1 = koffi.alloc('uint8', DXGI_ADAPTER_DESC1_SIZE);
          const hrDesc = slotFn(selected.ptr, SLOT_GET_DESC1, HR1, selected.ptr, desc1);
          if (hrDesc >= 0) {
            found = {
              low: koffi.decode(desc1, DESC1_LUID_LOW_OFF, 'uint32'),
              high: koffi.decode(desc1, DESC1_LUID_HIGH_OFF, 'int32'),
            };
          }
        }
      } catch {
        found = null;
      }
      luidCache.set(cacheKey, found);
      return found;
    },

    /**
     * System-wide FPS + the percentile stats (M7a/M12): the window
     * average (avgFps - the harmonic mean), the 1% Low, the 0.1% Low
     * (low01Pct - the >= 300-frame floor) and the 99% FPS. The FIRST
     * call starts the 200 ms sampler (the baseline reads happen on its
     * ticks); the poll NEVER reads the counters itself - the sample
     * derives from the ring: fps = the frames presented within the last
     * FPS_WINDOW_MS (M17b: 500 ms - the tightened 2-3-tick window)
     * scaled to per-second (rounded to 1 decimal; an empty ring
     * honestly reads 0 - the static-desktop shape, never '-'), avgFps
     * over the AVG_WINDOW_MS sub-window (M17b: the last 10 s),
     * low1Pct/low01Pct/p99 from the percentile math over the full 60 s
     * window (null until the 60-frame floor - the honest degrade). DXGI
     * unavailable → null.
     * @param {number} _deviceId (ignored - system-wide)
     * @returns {Promise<{ fps: number, avgFps: number | null, low1Pct: number | null, low01Pct: number | null, p99: number | null, frameTimeMs: null, gpuBusy: null } | null>}
     */
    async poll(_deviceId) {
      if (!init()) return null;
      ensureSampler();
      const at = now();
      try {
        // M17b (2d-1): the fps is the frame sum over the tightened
        // FPS_WINDOW_MS sub-window SCALED to per-second (frames /
        // windowSeconds) - a 500 ms window summing 90 frames reads 180.
        const frames = rollingFps(ring, at, FPS_WINDOW_MS);
        const fps = frames / (FPS_WINDOW_MS / 1000);
        // M17b (2d-2): the poll passes AVG_WINDOW_MS EXPLICITLY - avgFps
        // is the last-10 s window (the percentile tails keep the 60 s
        // window). Pinned by a test so a forgotten call cannot silently
        // regress (avgWindowMs defaults to the full window).
        const stats = percentileStats(ring, at, PERCENTILE_WINDOW_MS, AVG_WINDOW_MS);
        return {
          fps: Math.round(fps * 10) / 10,
          avgFps: stats === null ? null : stats.avgFps,
          low1Pct: stats === null ? null : stats.low1Pct,
          low01Pct: stats === null ? null : stats.low01Pct,
          p99: stats === null ? null : stats.p99,
          frameTimeMs: null,
          gpuBusy: null,
        };
      } catch {
        return null;
      }
    },

    async stop() {
      // M7a: the sampler interval dies with the adapter - a stopped
      // adapter never reads counters again.
      stopSampler();
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
      ring = [];
    },
  };
}
