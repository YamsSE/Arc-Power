// Arc Power - M17d the PresentMon SERVICE API bindings (pm-bindings.js -
// the koffi surface of PresentMonAPI2.dll, PresentMon v2.5.1 / API 3.3).
//
// The driver/IGS-shipped PresentMonAPI2.dll exposes the pm* service API
// (PresentMonAPI.h v3.3 - the exact generation the plan pins; verified
// against the upstream header at
// https://raw.githubusercontent.com/GameTechDev/PresentMon/v2.5.1/IntelPresentMon/PresentMonAPI2/PresentMonAPI.h
// and the v2.5.0 tag - the dev-box DLL v2.5.0.0 - which is API 3.3 and
// IDENTICAL for every surface bound here; cross-checked against the
// main-branch API 3.4 header). A client needs NO elevation (the service
// owns the ETW session; the control pipe grants GENERIC_ALL to
// Authenticated Users). The bindings are DEFENSIVE: every export is bound
// individually - an absent symbol makes THAT call null (the lane degrades,
// never a crash). The legacy generation detection: when the pm* exports
// are absent but api2_initialize exists, the DLL is the OLD api2_*
// generation (v2.0-2.2) - reported as apiGeneration 'api2' and NOT
// implemented (the fallback chain degrades to the vendored console-exe
// lane; NEVER a vendored DLL over the driver's - Intel's binary-compat
// warning).
//
// M17d step-4 S1: the signatures below were RE-verified against the real
// API 3.3 header (the round-1 findings - the four fatal ABI mismatches):
//   pmOpenSession(PM_SESSION_HANDLE* pHandle)         - ONE param, NO session type
//   pmRegisterDynamicQuery(session, pHandle, pElements,
//       uint64_t numElements, double windowSizeMs, double metricOffsetMs)
//   pmPollDynamicQuery(handle, processId, pBlob, uint32_t* numSwapChains)
//       - the plain poll has NO output timestamp (the WithTimestamp variant's
//         5th param is the INPUT nowTimestamp, not an output - it is NOT bound)
//   *numSwapChains is an IN-OUT count: the input is the max swap chains the
//       caller's blob holds (an input of 0 -> PM_STATUS_BAD_ARGUMENT,
//       PresentMonAPI.cpp:357-360) - the poll wrapper pre-encodes 1 (the
//       lane's padded blob holds exactly one).
//   pmGetApiVersion(PM_VERSION* pVersion)             - a 40-byte struct out-param
//
// The dynamic query uses the pure fps-pm-layout.ts enums + the
// PM_QUERY_ELEMENT layout (the run-A module): the koffi struct mirrors the
// layout (metric i32@0, stat i32@4, deviceId u32@8, arrayIndex u32@12,
// dataOffset u64@16, dataSize u64@24 - 32 bytes) and the poll blob is the
// caller-owned BYTE buffer the pure pmReadPollBlob decodes (the cheap-
// oracle seam). The blob the lane allocates is the MIDDLEWARE's per-swap-
// chain size - the 16-PADDED layout the pure module returns as blobSize
// (DynamicQuery.cpp:205-206: blobSize_ = PadToAlignment(blobCursor, 16);
// the poll writes numSwapChains * blobSize_ bytes). The register/poll/
// decode flow is unit-tested with a FAKE pm adapter (test/pm-bindings.test.js
// + test/fps-pm.test.js - scripted libs returning crafted blobs through
// the real pure decoder; the fake shapes pin the REAL arg counts/types so
// a re-introduced ABI mismatch fails the suite).
//
// PM_STATUS (PresentMonAPI.h v3.3 - the REAL values; only SUCCESS = 0 is
// treated as a pass by the lane):
//   PM_STATUS_SUCCESS = 0, FAILURE = 1, BAD_ARGUMENT = 2, BAD_HANDLE = 3,
//   SERVICE_ERROR = 4, INVALID_ETL_FILE = 5, INVALID_PID = 6,
//   ALREADY_TRACKING_PROCESS = 7, UNABLE_TO_CREATE_NSM = 8,
//   INVALID_ADAPTER_ID = 9, OUT_OF_RANGE = 10, INSUFFICIENT_BUFFER = 11,
//   PIPE_ERROR = 12, SESSION_NOT_OPEN = 13, MIDDLEWARE_MISSING_PATH = 14,
//   NONEXISTENT_FILE_PATH = 15, MIDDLEWARE_INVALID_SIGNATURE = 16,
//   MIDDLEWARE_MISSING_ENDPOINT = 17, MIDDLEWARE_VERSION_LOW = 18,
//   MIDDLEWARE_VERSION_HIGH = 19, MIDDLEWARE_SERVICE_MISMATCH = 20,
//   QUERY_MALFORMED = 21, MODE_MISMATCH = 22, FEATURE_DISABLED = 23.
//
// Electron-free (node --test) - the fake-lib fixture pattern of the NVML/ADL
// adapters.

import koffi from 'koffi';

/** The one PM_STATUS value that means success (PresentMonAPI.h v3.3). */
export const PM_STATUS_SUCCESS = 0;

// PM_QUERY_ELEMENT struct layout (x64 - PresentMonAPI.h):
//   metric      int32  @ 0
//   stat        int32  @ 4
//   deviceId    uint32 @ 8
//   arrayIndex  uint32 @ 12
//   dataOffset  uint64 @ 16
//   dataSize    uint64 @ 24
// total size = 32 bytes (the run-A pure layout module pins the same math -
// fps-pm-layout.ts pmQueryElements builds the descriptors).
koffi.struct('pm_query_element_t', {
  metric: 'int32',
  stat: 'int32',
  deviceId: 'uint32',
  arrayIndex: 'uint32',
  dataOffset: 'uint64',
  dataSize: 'uint64',
}); // 32 bytes, align 8

// PM_VERSION struct layout (x64 - PresentMonAPI.h):
//   major  uint16 @ 0
//   minor  uint16 @ 2
//   patch  uint16 @ 4
//   tag    char[22] @ 6
//   hash   char[8] @ 28
//   config char[4] @ 36
// total size = 40 bytes. pmGetApiVersion is a TEST-ONLY surface (the
// product path never calls it - the dev-box IGS DLL corrupts the heap on
// the call, flagged in the reports) but it is bound with the REAL struct
// shape so the buffer is never undersized.
koffi.struct('pm_version_t', {
  major: 'uint16',
  minor: 'uint16',
  patch: 'uint16',
  tag: 'char[22]',
  hash: 'char[8]',
  config: 'char[4]',
}); // 40 bytes

// Layout assertions (the pure layout module's PmQueryElement shape + the
// header's PM_VERSION shape - a mismatch here means the ABI drift would
// corrupt the heap; refuse to continue).
const PM_QUERY_ELEMENT_EXPECTED_SIZE = 32;
const PM_VERSION_EXPECTED_SIZE = 40;
const pmElementSize = koffi.sizeof('pm_query_element_t');
const pmVersionSize = koffi.sizeof('pm_version_t');
if (pmElementSize !== PM_QUERY_ELEMENT_EXPECTED_SIZE) {
  throw new Error(`Layout mismatch: koffi sizeof(pm_query_element_t) = ${pmElementSize}, expected ${PM_QUERY_ELEMENT_EXPECTED_SIZE} (PresentMonAPI.h, MSVC x64). Refusing to continue.`);
}
if (pmVersionSize !== PM_VERSION_EXPECTED_SIZE) {
  throw new Error(`Layout mismatch: koffi sizeof(pm_version_t) = ${pmVersionSize}, expected ${PM_VERSION_EXPECTED_SIZE} (PresentMonAPI.h, MSVC x64). Refusing to continue.`);
}

/** The PM_STATUS name map (the lane's degrade logs - a failed call reports
 *  the name, never a bare code; the values are the REAL API 3.3 enum). */
export const PM_STATUS_NAMES = Object.freeze({
  0: 'SUCCESS', 1: 'FAILURE', 2: 'BAD_ARGUMENT', 3: 'BAD_HANDLE',
  4: 'SERVICE_ERROR', 5: 'INVALID_ETL_FILE', 6: 'INVALID_PID',
  7: 'ALREADY_TRACKING_PROCESS', 8: 'UNABLE_TO_CREATE_NSM',
  9: 'INVALID_ADAPTER_ID', 10: 'OUT_OF_RANGE', 11: 'INSUFFICIENT_BUFFER',
  12: 'PIPE_ERROR', 13: 'SESSION_NOT_OPEN', 14: 'MIDDLEWARE_MISSING_PATH',
  15: 'NONEXISTENT_FILE_PATH', 16: 'MIDDLEWARE_INVALID_SIGNATURE',
  17: 'MIDDLEWARE_MISSING_ENDPOINT', 18: 'MIDDLEWARE_VERSION_LOW',
  19: 'MIDDLEWARE_VERSION_HIGH', 20: 'MIDDLEWARE_SERVICE_MISMATCH',
  21: 'QUERY_MALFORMED', 22: 'MODE_MISMATCH', 23: 'FEATURE_DISABLED',
});

/** The pm* symbols the lane binds (the defensive export list). */
export const PM_EXPORTS = Object.freeze({
  openSession: 'pmOpenSession',
  closeSession: 'pmCloseSession',
  startTrackingProcess: 'pmStartTrackingProcess',
  stopTrackingProcess: 'pmStopTrackingProcess',
  registerDynamicQuery: 'pmRegisterDynamicQuery',
  pollDynamicQuery: 'pmPollDynamicQuery',
  setEtwFlushPeriod: 'pmSetEtwFlushPeriod',
  getApiVersion: 'pmGetApiVersion',
});

/** The legacy api2_* marker export (the v2.0-2.2 generation detection). */
export const API2_INITIALIZE_EXPORT = 'api2_initialize';

/**
 * Copy a koffi-alloc'd poll blob into a plain Uint8Array - the pure
 * pmReadPollBlob decoder consumes (the koffi pointer object is not a
 * DataView-able buffer; a Node Buffer is NOT writable by koffi - passing
 * one as the poll out-param corrupts the heap, live-verified). The blob
 * sizes are tiny (the query elements ~20 bytes, padded to the middleware's
 * 16-aligned stride) - a per-byte copy is trivially cheap. Garbage -> null
 * (the poll degrades).
 * @param {object} blob the koffi-alloc'd poll buffer
 * @param {number} blobSize the blob size (the pure layout's 16-padded blobSize)
 * @returns {Uint8Array | null}
 */
function copyBlobBytes(blob, blobSize) {
  try {
    const n = Number.isInteger(blobSize) && blobSize > 0 ? blobSize : 0;
    if (n === 0) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = koffi.decode(blob, i, 'uint8');
    return out;
  } catch {
    return null;
  }
}

/**
 * Bind the pm* API surface of PresentMonAPI2.dll (or an injected fake lib -
 * the test seam). DEFENSIVE: each export is bound individually - an absent
 * export makes that call null (never a throw). The GENERATION detection:
 * pmOpenSession bound -> 'pm3'; only api2_initialize bound -> 'api2' (the
 * legacy generation - reported, NOT implemented - the lane degrades to the
 * fallback chain); neither -> null (no usable API). A load failure (missing
 * DLL / missing dependencies) degrades to null the same way.
 * @param {{
 *   lib?: object|null,      // injected bound lib (tests - the NVML fake-lib
 *                           // pattern: { func(name, ret, params) }); loaded
 *                           // from dllPath at init otherwise
 *   dllPath?: string|null,  // the DLL to koffi.load (null + no lib -> null)
 * }} deps
 * @returns {{
 *   generation: 'pm3' | 'api2' | null,
 *   dllPath: string | null,
 *   openSession: Function | null,   // () => { ok, session } - opens the
 *                                   // service session (uint64 handle); API
 *                                   // 3.3 pmOpenSession is ONE param (the
 *                                   // PM_SESSION_HANDLE* out-ptr) - there is
 *                                   // NO session-type argument
 *   closeSession: Function | null,  // (session) => boolean
 *   startTrackingProcess: Function | null,  // (session, pid) => boolean
 *   stopTrackingProcess: Function | null,   // (session, pid) => boolean
 *   registerDynamicQuery: Function | null,  // (session, elements, blobSize,
 *                                   // windowSizeMs, metricOffsetMs?) => { ok,
 *                                   // handle, blob, blobSize } - blobSize is
 *                                   // the middleware's 16-padded per-swap-
 *                                   // chain blob size (the pure layout's)
 *   pollDynamicQuery: Function | null,      // (handle, pid, blob) => { ok,
 *                                   // numSwapChains, bytes } - *numSwapChains
 *                                   // is pre-encoded to 1 on input (the IN-OUT
 *                                   // count; an input of 0 = BAD_ARGUMENT)
 *   setEtwFlushPeriod: Function | null,     // (session, periodMs) => boolean
 *   getApiVersion: Function | null,         // () => number | null (the
 *                                   // PM_VERSION major<<16|minor - TEST-ONLY)
 * } | null}
 */
export function createPmBindings({ lib = null, dllPath = null } = {}) {
  let loaded = lib;
  let error = null;
  if (loaded === null) {
    if (typeof dllPath !== 'string' || dllPath.length === 0) return null;
    try {
      loaded = koffi.load(dllPath);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return null;
    }
  }
  try {
    const bind = (name, ret, params) => {
      try {
        return loaded.func(name, ret, params);
      } catch {
        return null; // an absent export degrades that call (never the whole adapter)
      }
    };
    const fn = {
      // The REAL API 3.3 signatures (PresentMonAPI.h v2.5.1/v2.5.0 tags -
      // identical; verified in the round-1 findings): pmOpenSession is ONE
      // param (PM_SESSION_HANDLE* out - no session type); pmRegisterDynamicQuery
      // takes a uint64 element count + DOUBLE window/offset; the plain poll
      // has the uint32* numSwapChains IN-OUT count and NO output timestamp;
      // pmGetApiVersion writes a PM_VERSION struct.
      openSession: bind(PM_EXPORTS.openSession, 'int', ['void*']),
      closeSession: bind(PM_EXPORTS.closeSession, 'int', ['uint64']),
      startTrackingProcess: bind(PM_EXPORTS.startTrackingProcess, 'int', ['uint64', 'uint32']),
      stopTrackingProcess: bind(PM_EXPORTS.stopTrackingProcess, 'int', ['uint64', 'uint32']),
      registerDynamicQuery: bind(PM_EXPORTS.registerDynamicQuery, 'int', ['uint64', 'void*', 'void*', 'uint64', 'double', 'double']),
      pollDynamicQuery: bind(PM_EXPORTS.pollDynamicQuery, 'int', ['uint64', 'uint32', 'void*', 'void*']),
      setEtwFlushPeriod: bind(PM_EXPORTS.setEtwFlushPeriod, 'int', ['uint64', 'uint32']),
      getApiVersion: bind(PM_EXPORTS.getApiVersion, 'int', ['void*']),
      api2Initialize: bind(API2_INITIALIZE_EXPORT, 'int', []),
    };
    const generation = fn.openSession !== null ? 'pm3'
      : (fn.api2Initialize !== null ? 'api2' : null);
    if (generation === null) return null;

    const apiVersionOf = () => {
      if (fn.getApiVersion === null) return null;
      try {
        const buf = koffi.alloc('pm_version_t', 1);
        if (fn.getApiVersion(buf) !== PM_STATUS_SUCCESS) return null;
        const v = koffi.decode(buf, 0, 'pm_version_t');
        if (typeof v.major !== 'number' || typeof v.minor !== 'number') return null;
        return (v.major << 16) | v.minor;
      } catch {
        return null;
      }
    };

    // The session/query HANDLE buffers (PM_SESSION / PM_QUERY_HANDLE are
    // uint64 out-params on the x64 API). pmOpenSession takes NO session
    // type (the round-1 S1 fix: the old 2-arg shape put the session type 0
    // in RCX = the native pHandle and pmOpenSessionWithPipe answered
    // BAD_ARGUMENT on the null out-ptr - the session could never open).
    const openSession = fn.openSession === null ? null : () => {
      try {
        const handleBuf = koffi.alloc('uint64', 1);
        if (fn.openSession(handleBuf) !== PM_STATUS_SUCCESS) {
          return { ok: false, session: null };
        }
        const session = koffi.decode(handleBuf, 0, 'uint64');
        return { ok: true, session: Number(session) };
      } catch {
        return { ok: false, session: null };
      }
    };
    const closeSession = fn.closeSession === null ? null : (session) => {
      try {
        return fn.closeSession(Number(session)) === PM_STATUS_SUCCESS;
      } catch {
        return false;
      }
    };
    const startTrackingProcess = fn.startTrackingProcess === null ? null : (session, pid) => {
      try {
        return fn.startTrackingProcess(Number(session), pid) === PM_STATUS_SUCCESS;
      } catch {
        return false;
      }
    };
    const stopTrackingProcess = fn.stopTrackingProcess === null ? null : (session, pid) => {
      try {
        return fn.stopTrackingProcess(Number(session), pid) === PM_STATUS_SUCCESS;
      } catch {
        return false;
      }
    };
    const setEtwFlushPeriod = fn.setEtwFlushPeriod === null ? null : (session, periodMs) => {
      try {
        return fn.setEtwFlushPeriod(Number(session), periodMs) === PM_STATUS_SUCCESS;
      } catch {
        return false;
      }
    };
    // Register the dynamic query: the descriptors come from the pure layout
    // module (pmQueryElements - the dataOffset/dataSize math is pure); the
    // koffi side only marshals them + owns the poll blob. The blob is a
    // zeroed caller-owned buffer the poll writes the per-element values
    // into (the pure pmReadPollBlob decodes it). blobSize is the pure
    // layout's 16-ALIGNED size - the middleware's per-swap-chain stride
    // (DynamicQuery.cpp:205-206) - so the blob can hold one padded blob;
    // the poll pre-encodes *numSwapChains = 1.
    const registerDynamicQuery = fn.registerDynamicQuery === null ? null : (session, elements, blobSize, windowSizeMs, metricOffsetMs = 0) => {
      try {
        const handleBuf = koffi.alloc('uint64', 1);
        const elementsBuf = koffi.alloc('pm_query_element_t', elements.length);
        // koffi encode/decode on an allocated array address BYTE OFFSETS
        // (element i sits at i * 32 - the pinned struct size).
        elements.forEach((e, i) => {
          koffi.encode(elementsBuf, i * PM_QUERY_ELEMENT_EXPECTED_SIZE, 'pm_query_element_t', {
            metric: e.metric,
            stat: e.stat,
            deviceId: e.deviceId,
            arrayIndex: e.arrayIndex,
            dataOffset: e.dataOffset,
            dataSize: e.dataSize,
          });
        });
        if (fn.registerDynamicQuery(Number(session), handleBuf, elementsBuf, elements.length, windowSizeMs, metricOffsetMs) !== PM_STATUS_SUCCESS) {
          return { ok: false, handle: null, blob: null };
        }
        const handle = koffi.decode(handleBuf, 0, 'uint64');
        const blob = koffi.alloc('uint8', blobSize);
        return { ok: true, handle: Number(handle), blob, blobSize };
      } catch {
        return { ok: false, handle: null, blob: null };
      }
    };
    // The plain poll (round-1 S1: the WithTimestamp variant is NOT bound -
    // its 5th param is the INPUT nowTimestamp, not an output, and there is
    // no poll output timestamp in API 3.3; the dry signal comes from the
    // service writing AVG = 0.0 on a dry window + the pure decoder's 0-fps
    // rejection). *numSwapChains is an IN-OUT count: the input is the max
    // swap chains the blob holds - pre-encoded to 1 (an input of 0 answers
    // PM_STATUS_BAD_ARGUMENT, PresentMonAPI.cpp:357-360). The blob bytes are
    // copied into a Uint8Array (a koffi pointer is NOT a DataView-able
    // buffer) for the pure pmReadPollBlob decode - the cheap-oracle seam.
    const pollDynamicQuery = fn.pollDynamicQuery === null ? null : (handle, pid, blob, blobSize) => {
      try {
        const numBuf = koffi.alloc('uint32', 1);
        koffi.encode(numBuf, 0, 'uint32', 1); // numSwapChains IN-OUT: input = 1 (the lane's padded blob holds exactly one)
        if (fn.pollDynamicQuery(Number(handle), pid, blob, numBuf) !== PM_STATUS_SUCCESS) {
          return { ok: false, numSwapChains: 0, bytes: null };
        }
        return { ok: true, numSwapChains: koffi.decode(numBuf, 0, 'uint32'), bytes: copyBlobBytes(blob, blobSize) };
      } catch {
        return { ok: false, numSwapChains: 0, bytes: null };
      }
    };
    const getApiVersion = fn.getApiVersion === null ? null : apiVersionOf;

    return {
      generation,
      dllPath: loaded !== lib ? dllPath : null,
      error,
      openSession,
      closeSession,
      startTrackingProcess,
      stopTrackingProcess,
      registerDynamicQuery,
      pollDynamicQuery,
      setEtwFlushPeriod,
      getApiVersion,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return null;
  }
}
