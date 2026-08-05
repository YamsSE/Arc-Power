// Arc Power — M2b PresentMonClient (FPS / frame-time via PresentMonAPI2).
//
// PresentMon v2.5.1 session API (the PMInitialize/PMGetLatestFrameEvent
// surface from v1.x was REMOVED in v2.0 — this is the supported API).
// Vendored DLL: tools/presentmon/PresentMonAPI2.dll (x64, v2.5.1.0) from
//   https://github.com/GameTechDev/PresentMon/releases/tag/v2.5.1
//   (PresentMon-v2.5.1.msi -> PresentMonSharedService\PresentMonAPI2.dll)
//   the BINARY is gitignored (tools/presentmon/); at runtime the client
//   looks for it in tools/presentmon/ relative to the app root, then in the
//   app dir. The PresentMonService (PresentMonService.exe from the same MSI)
//   must be running — the client reports unavailable when the session cannot
//   open (PM_STATUS_SERVICE_ERROR etc.). Never throws, never crashes the app.
//
// Data flow: pmOpenSession -> pmStartTrackingProcess(pid) ->
// pmRegisterFrameQuery(elements) -> pmConsumeFrames(blob, &n) ->
// decodeFrameSample(blob, elements). Frame-event blobs are laid out per the
// query elements: the service fills each element's dataOffset/dataSize into
// the caller's element array at register time; each consumed frame is
// blobSize bytes with the element values at those offsets (see
// docs/presentmon.md for the layout notes).

import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';

export const PM_STATUS = {
  SUCCESS: 0,
  FAILURE: 1,
  BAD_ARGUMENT: 2,
  BAD_HANDLE: 3,
  SERVICE_ERROR: 4,
  INVALID_ETL_FILE: 5,
  INVALID_PID: 6,
  ALREADY_TRACKING_PROCESS: 7,
  UNABLE_TO_CREATE_NSM: 8,
  INVALID_ADAPTER_ID: 9,
  OUT_OF_RANGE: 10,
  INSUFFICIENT_BUFFER: 11,
  PIPE_ERROR: 12,
  SESSION_NOT_OPEN: 13,
  MIDDLEWARE_MISSING_PATH: 14,
  NONEXISTENT_FILE_PATH: 15,
  MIDDLEWARE_INVALID_SIGNATURE: 16,
  MIDDLEWARE_MISSING_ENDPOINT: 17,
  MIDDLEWARE_VERSION_LOW: 18,
  MIDDLEWARE_VERSION_HIGH: 19,
  MIDDLEWARE_SERVICE_MISMATCH: 20,
  QUERY_MALFORMED: 21,
  MODE_MISMATCH: 22,
  FEATURE_DISABLED: 23,
};

export const PM_STATUS_NAME = {};
for (const [k, v] of Object.entries(PM_STATUS)) PM_STATUS_NAME[v] = k;

// Frame metrics consumed (enum values from presentmonapi2.h v2.5.1).
// kUniversalDeviceId = 0 (fps/frame-time metrics are universal, not
// per-GPU); kSystemDeviceId = 65536.
export const PM_METRIC = {
  DISPLAYED_FPS: 12,
  PRESENTED_FPS: 13,
  GPU_BUSY: 15,
  DISPLAYED_FRAME_TIME: 137,
  PRESENTED_FRAME_TIME: 139,
};
export const PM_UNIVERSAL_DEVICE_ID = 0;

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

// pm_query_element_t { PM_METRIC metric@0 (int32), PM_STAT stat@4,
//   uint32_t deviceId@8, uint32_t arrayIndex@12, uint64_t dataOffset@16,
//   uint64_t dataSize@24 } = 32 bytes, align 8
const pm_query_element_t = koffi.struct('pm_query_element_t', {
  metric: 'int32',
  stat: 'int32',
  deviceId: 'uint32',
  arrayIndex: 'uint32',
  dataOffset: 'uint64',
  dataSize: 'uint64',
});

// pm_version_t { uint16 major@0, uint16 minor@2, uint16 patch@4,
//   char tag[22]@6, char hash[8]@28, char config[4]@36 } = 40 bytes, align 2
const pm_version_t = koffi.struct('pm_version_t', {
  major: 'uint16',
  minor: 'uint16',
  patch: 'uint16',
  tag: 'char[22]',
  hash: 'char[8]',
  config: 'char[4]',
});

for (const [name, expected] of Object.entries({
  pm_query_element_t: 32,
  pm_version_t: 40,
})) {
  const actual = koffi.sizeof(name);
  if (actual !== expected) {
    throw new Error(`Layout mismatch: koffi sizeof(${name}) = ${actual}, expected ${expected} (presentmonapi2.h v2.5.1, MSVC x64). Refusing to continue.`);
  }
}

// ---------------------------------------------------------------------------
// DLL discovery + binding
// ---------------------------------------------------------------------------

export function findPresentMonDll() {
  const appDir = path.dirname(process.execPath);
  const candidates = [
    process.env.PM_API2_DLL_PATH,
    path.join(process.cwd(), 'tools', 'presentmon', 'PresentMonAPI2.dll'),
    path.join(appDir, 'tools', 'presentmon', 'PresentMonAPI2.dll'),
    path.join(appDir, 'PresentMonAPI2.dll'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export function loadPresentMon(dllPath) {
  const lib = koffi.load(dllPath);
  const fn = { unavailable: [] };
  const bind = (name, ret, params) => {
    try {
      fn[name] = lib.func(name, ret, params);
    } catch {
      fn.unavailable.push(name);
    }
  };
  bind('pmGetApiVersion', 'int32', ['pm_version_t*']);
  bind('pmOpenSession', 'int32', ['void**']);
  bind('pmCloseSession', 'int32', ['void*']);
  bind('pmStartTrackingProcess', 'int32', ['void*', 'uint32']);
  bind('pmStopTrackingProcess', 'int32', ['void*', 'uint32']);
  bind('pmRegisterFrameQuery', 'int32', ['void*', 'void**', 'pm_query_element_t*', 'uint64', 'uint32*']);
  bind('pmConsumeFrames', 'int32', ['void*', 'uint32', 'uint8*', 'uint32*']);
  bind('pmFreeFrameQuery', 'int32', ['void*']);
  bind('pmSetEtwFlushPeriod', 'int32', ['void*', 'uint32']);
  return fn;
}

// ---------------------------------------------------------------------------
// Pure decode (fixture-tested; works on Node Buffers and koffi pointers)
// ---------------------------------------------------------------------------

/**
 * Decode one consumed frame blob into a Monitoring sample. The blob layout
 * comes from the registered query elements (dataOffset/dataSize per element,
 * filled in by pmRegisterFrameQuery). All three metrics are doubles.
 * @param {Buffer | object} blob blob bytes (Node Buffer or a koffi buffer)
 * @param {Array<{ metric: number, dataOffset: number, dataSize: number }>} elements
 * @returns {{ fps: number|null, frameTimeMs: number|null, gpuBusy: number|null, presentedFps: number|null }}
 */
export function decodeFrameSample(blob, elements) {
  const readDouble = (offset) => (typeof blob.readDoubleLE === 'function'
    ? blob.readDoubleLE(offset)
    : koffi.decode(blob, offset, 'double'));
  const byMetric = (metric) => elements.find((e) => e.metric === metric);
  const d = (metric) => {
    const e = byMetric(metric);
    if (!e || typeof e.dataOffset !== 'number' || e.dataSize === 0) return null;
    return readDouble(e.dataOffset);
  };
  const fps = d(PM_METRIC.DISPLAYED_FPS);
  const presentedFps = d(PM_METRIC.PRESENTED_FPS);
  const gpuBusy = d(PM_METRIC.GPU_BUSY);
  let frameTimeMs = d(PM_METRIC.DISPLAYED_FRAME_TIME);
  if (frameTimeMs === null) frameTimeMs = d(PM_METRIC.PRESENTED_FRAME_TIME);
  return {
    fps: fps !== null && Number.isFinite(fps) ? fps : (presentedFps !== null && Number.isFinite(presentedFps) ? presentedFps : null),
    frameTimeMs: frameTimeMs !== null && Number.isFinite(frameTimeMs) ? frameTimeMs : null,
    gpuBusy: gpuBusy !== null && Number.isFinite(gpuBusy) ? gpuBusy : null,
    presentedFps: presentedFps !== null && Number.isFinite(presentedFps) ? presentedFps : null,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * PresentMon FPS client. Graceful no-DLL / no-service degradation: a missing
 * DLL or a failed session leaves `available=false`; poll() returns null;
 * nothing ever throws.
 * Interface (consumed by M2b-B Monitoring): start(deviceId, pid),
 * poll() -> sample|null, stop().
 */
export class PresentMonClient {
  constructor(opts = {}) {
    this._dllPath = opts.dllPath ?? findPresentMonDll();
    this._lib = null;
    this.available = this._dllPath !== null;
    this.availableReason = this.available ? null : 'PresentMonAPI2.dll not found (expected in tools/presentmon/ or the app dir)';
    this._session = null;
    this._query = null;
    this._blobSize = 0;
    this._elements = [];
    this._pid = null;
    this._blob = null;
  }

  async start(_deviceId, pid) {
    if (!this.available) return { ok: false, reason: this.availableReason };
    try {
      if (!this._lib) {
        this._lib = loadPresentMon(this._dllPath);
        if (!this._lib.pmOpenSession) {
          this.available = false;
          this.availableReason = 'PresentMonAPI2.dll loaded but pmOpenSession is missing';
          return { ok: false, reason: this.availableReason };
        }
      }
      const sessionBuf = koffi.alloc('void*', 1);
      let st = this._lib.pmOpenSession(sessionBuf);
      if (st !== PM_STATUS.SUCCESS) {
        this.available = false;
        this.availableReason = `PresentMon service unavailable (${describePmStatus(st)})`;
        return { ok: false, reason: this.availableReason };
      }
      this._session = koffi.decode(sessionBuf, 'void*');
      st = this._lib.pmStartTrackingProcess(this._session, pid);
      if (st !== PM_STATUS.SUCCESS) {
        await this._cleanupSession();
        return { ok: false, reason: `pmStartTrackingProcess(${pid}) -> ${describePmStatus(st)}` };
      }
      // Ask for a short ETW flush period so frames arrive quickly.
      try { this._lib.pmSetEtwFlushPeriod(this._session, 8); } catch { /* best effort */ }

      // Primary query: presented-based metrics. DISPLAYED_* (displayed fps /
      // displayed frame time) are NOT exported by the ETW source on this
      // machine (pmRegisterFrameQuery -> QUERY_MALFORMED / FAILURE, verified
      // on the A770 with driver 32.0.101.8861), so the primary set avoids
      // them. PRESENTED_FRAME_TIME is also unexported -> FAILURE, so the
      // frame-time metric only appears in the fallback if the device exports
      // it (the decoder reads it when present).
      const primary = [
        { metric: PM_METRIC.PRESENTED_FPS, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
        { metric: PM_METRIC.GPU_BUSY, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
        { metric: PM_METRIC.PRESENTED_FRAME_TIME, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
      ];
      st = this._registerFrameQuery(primary);
      if (st !== PM_STATUS.SUCCESS) {
        // Fallback 1: fps + gpu-busy (the verified-exportable pair).
        const fpsBusy = [
          { metric: PM_METRIC.PRESENTED_FPS, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
          { metric: PM_METRIC.GPU_BUSY, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
        ];
        st = this._registerFrameQuery(fpsBusy);
      }
      if (st !== PM_STATUS.SUCCESS) {
        // Fallback 2: the minimal presented-fps-only query (universally
        // exported; covers setups where GPU_BUSY is not exported either).
        const minimal = [
          { metric: PM_METRIC.PRESENTED_FPS, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
        ];
        st = this._registerFrameQuery(minimal);
        if (st !== PM_STATUS.SUCCESS) {
          await this._cleanupSession();
          return { ok: false, reason: `pmRegisterFrameQuery -> ${describePmStatus(st)}` };
        }
      }
      this._pid = pid;
      this._blob = koffi.alloc('uint8', this._blobSize);
      return { ok: true };
    } catch (err) {
      this.available = false;
      this.availableReason = `PresentMon client error: ${err.message}`;
      return { ok: false, reason: this.availableReason };
    }
  }

  _registerFrameQuery(elements) {
    const buf = koffi.alloc('pm_query_element_t', elements.length);
    for (let i = 0; i < elements.length; i++) {
      koffi.encode(buf, i * 32, 'pm_query_element_t', elements[i]);
    }
    const queryBuf = koffi.alloc('void*', 1);
    const blobSizeBuf = koffi.alloc('uint32', 1);
    const st = this._lib.pmRegisterFrameQuery(this._session, queryBuf, buf, elements.length, blobSizeBuf);
    if (st !== PM_STATUS.SUCCESS) return st;
    this._query = koffi.decode(queryBuf, 'void*');
    this._blobSize = koffi.decode(blobSizeBuf, 'uint32');
    // Read back the offsets the service assigned.
    this._elements = [];
    for (let i = 0; i < elements.length; i++) {
      const e = koffi.decode(buf, i * 32, 'pm_query_element_t');
      this._elements.push({ metric: e.metric, stat: e.stat, deviceId: e.deviceId, arrayIndex: e.arrayIndex, dataOffset: e.dataOffset, dataSize: e.dataSize });
    }
    return st;
  }

  async _cleanupSession() {
    try {
      if (this._query) { this._lib.pmFreeFrameQuery(this._query); this._query = null; }
    } catch { /* best effort */ }
    try {
      if (this._session) { this._lib.pmCloseSession(this._session); this._session = null; }
    } catch { /* best effort */ }
  }

  /**
   * @returns {Promise<{ fps: number|null, frameTimeMs: number|null, gpuBusy: number|null, presentedFps: number|null } | null>}
   */
  async poll() {
    if (!this._session || !this._query || !this._pid) return null;
    try {
      const numBuf = koffi.alloc('uint32', 1);
      koffi.encode(numBuf, 'uint32', 1);
      const st = this._lib.pmConsumeFrames(this._query, this._pid, this._blob, numBuf);
      const framesRead = koffi.decode(numBuf, 'uint32');
      if (st !== PM_STATUS.SUCCESS || framesRead < 1) return null;
      return decodeFrameSample(this._blob, this._elements);
    } catch {
      return null;
    }
  }

  async stop() {
    try {
      if (this._session && this._pid) {
        try { this._lib.pmStopTrackingProcess(this._session, this._pid); } catch { /* best effort */ }
      }
      await this._cleanupSession();
    } catch { /* best effort */ }
    this._pid = null;
    this._blob = null;
    this._elements = [];
  }
}

export function describePmStatus(code) {
  return `${PM_STATUS_NAME[code] ?? 'UNKNOWN'} (${code})`;
}

/**
 * M2b-B FPS adapter for the IPC layer: lazy single-client wrapper around
 * PresentMonClient. The first poll starts the client (tracking `pid`); a
 * failed start (missing DLL / service down) leaves the adapter permanently
 * unavailable and every poll returns null — never throws. `pid` defaults to
 * the main-process pid (the app's own frames; a game-tracking list is a
 * future milestone). `stop` is best-effort and resets the start latch.
 * @param {{ client?: PresentMonClient, pid?: number }} [opts]
 */
export function createPresentmonAdapter(opts = {}) {
  const pid = opts.pid ?? process.pid;
  let client = opts.client ?? null;
  let started = false;
  return {
    /**
     * @param {number} deviceId
     * @returns {Promise<{ fps: number | null, frameTimeMs: number | null, gpuBusy: number | null } | null>}
     */
    async poll(deviceId) {
      if (!started) {
        started = true;
        if (!client) client = new PresentMonClient();
        try {
          const out = await client.start(deviceId, pid);
          if (!out.ok) client = null;
        } catch {
          client = null;
        }
      }
      if (!client) return null;
      try {
        return await client.poll();
      } catch {
        return null;
      }
    },
    async stop() {
      if (client) {
        try { await client.stop(); } catch { /* best effort */ }
        client = null;
      }
      started = false;
    },
  };
}
