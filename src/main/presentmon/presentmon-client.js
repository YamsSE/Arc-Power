// Arc Power — M2b/M3-C-L PresentMonClient (FPS / frame-time via PMAPI2).
//
// PresentMon v2.5.1 session API (the PMInitialize/PMGetLatestFrameEvent
// surface from v1.x was REMOVED in v2.0 — this is the supported API).
// Vendored binaries: tools/presentmon/ (PresentMonAPI2.dll x64 v2.5.1.0,
// PresentMonService.exe + the same DLL from the SAME v2.5.1 release) from
//   https://github.com/GameTechDev/PresentMon/releases/tag/v2.5.1
//   (PresentMon-v2.5.1.msi -> PresentMonSharedService\{PresentMonService.exe,
//   PresentMonAPI2.dll} — the "shared service" implementation lives IN
//   PresentMonAPI2.dll, which the service exe hosts; there is no separate
//   PresentMonSharedService.dll in v2.5.1).
//
// M3-C-L mechanism (verified live by the feasibility probe):
//   - tracking is per-pid ONLY (pmStartTrackingProcess / per-pid
//     pmConsumeFrames — pmStartTrackingAllProcesses does NOT exist in
//     v2.5.1); the tracked pid is the FOREGROUND-WINDOW pid
//     (GetForegroundWindow / GetWindowThreadProcessId via koffi user32),
//     re-tracked on focus change (stop old pid, start new) — a game/video
//     in the foreground shows its FPS. Process-enumeration aggregation is
//     explicitly out of scope (documented enhancement).
//   - the service runs STANDALONE as a per-user child process (feasibility
//     verdict): the adapter spawns PresentMonService.exe with a
//     SESSION-LOCAL shm prefix (--shm-name-prefix Local\... — the Global\
//     default needs elevation, which the packaged app has anyway, but the
//     Local prefix works in both), and pmOpenSession succeeds against it.
//     If the spawn/session fails the client degrades to the honest "FPS
//     unavailable" (never crashes).
//
// Data flow: pmOpenSession -> pmStartTrackingProcess(pid) ->
// pmRegisterFrameQuery(elements) -> pmConsumeFrames(blob, &n) ->
// decodeFrameSample(blob, elements). Frame-event blobs are laid out per the
// query elements: the service fills each element's dataOffset/dataSize into
// the caller's element array at register time; each consumed frame is
// blobSize bytes with the element values at those offsets (see
// docs/presentmon.md for the layout notes).

import koffi from 'koffi';
import { spawn as nodeSpawn } from 'node:child_process';
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
    // Packaged: the asarUnpack'd tools/presentmon/ (native DLLs need real files).
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', 'presentmon', 'PresentMonAPI2.dll')
      : null,
    path.join(process.cwd(), 'tools', 'presentmon', 'PresentMonAPI2.dll'),
    path.join(appDir, 'tools', 'presentmon', 'PresentMonAPI2.dll'),
    path.join(appDir, 'PresentMonAPI2.dll'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * M3-C-L: locate PresentMonService.exe — always next to the DLL (the SAME
 * v2.5.1 release guarantees the service exe + client DLL agree).
 * @param {string} [dllPath] resolved DLL path (default findPresentMonDll)
 * @returns {string | null}
 */
export function findPresentMonService(dllPath) {
  const dll = dllPath ?? findPresentMonDll();
  if (!dll) return null;
  const svc = path.join(path.dirname(dll), 'PresentMonService.exe');
  return fs.existsSync(svc) ? svc : null;
}

/**
 * M3-C-L: the FOREGROUND-WINDOW pid — the M3-C-L tracking mechanism. The
 * app's own pid presents nothing; a game/video in the foreground does.
 * Pure-ish: the user32 bindings are injectable for tests (koffi.load is
 * skipped entirely when `deps.lib` is given). Returns null when there is
 * no foreground window (desktop focused) or the call fails — the adapter
 * then keeps the previous target (or tracks nothing).
 * @param {{ lib?: object }} [deps]
 * @returns {number | null}
 */
export function resolveForegroundPid(deps = {}) {
  try {
    const user32 = deps.lib ?? koffi.load('user32.dll');
    const getForegroundWindow = user32.func('void* GetForegroundWindow(void)');
    const getWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hWnd, uint32* lpdwProcessId)');
    const hwnd = getForegroundWindow();
    if (!hwnd) return null;
    const pidBuf = koffi.alloc('uint32', 1);
    koffi.encode(pidBuf, 'uint32', 0);
    getWindowThreadProcessId(hwnd, pidBuf);
    const pid = koffi.decode(pidBuf, 'uint32');
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * M3-C-L: spawn PresentMonService.exe standalone as a per-user child
 * (feasibility verdict: pmOpenSession succeeds against a session-local
 * service without elevation). The shm prefix is SESSION-LOCAL — the
 * Global\ default needs elevation, and the Local prefix works in both the
 * non-elevated dev run and the always-elevated packaged app.
 * @param {{ serviceExe?: string, spawn?: typeof nodeSpawn, log?: (s: string) => void }} [deps]
 * @returns {{ child: import('node:child_process').ChildProcess | null, reason?: string }}
 */
export function spawnPresentMonService(deps = {}) {
  const exe = deps.serviceExe ?? findPresentMonService();
  if (!exe) return { child: null, reason: 'PresentMonService.exe not found (expected next to PresentMonAPI2.dll)' };
  try {
    // M3-C-L F1 (review): stdio is DRAINED ('ignore' -> the service's stdio
    // handles point at the null device). The service runs with
    // --enable-stdio-log; with the old pipe'd stdout/stderr nobody reads, a
    // 64 KB pipe buffer fill would BLOCK the service mid-session (no more
    // frames, no more session responses). 'ignore' makes that impossible.
    const child = (deps.spawn ?? nodeSpawn)(exe, [
      '--shm-name-prefix', 'Local\\pm_svc_shm',
      '--etw-session-name', 'PMArcPower',
      '--enable-stdio-log',
      '--log-level', 'warning',
    ], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
    child.on('error', () => { /* the session probe reports the failure honestly */ });
    return { child };
  } catch (err) {
    return { child: null, reason: `PresentMonService spawn failed: ${err.message}` };
  }
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
    // M3-C-L: injectable bound lib (tests use a fake; the product path
    // loads the DLL lazily in start()).
    this._lib = opts.lib ?? null;
    // M3-C-L F1 (review): the service needs a moment to come up before the
    // first pmOpenSession succeeds (the feasibility probe needed ~2500 ms).
    // Retry with backoff instead of declaring the client unavailable on the
    // first poll — a transient first failure must not kill FPS for the
    // whole session.
    this._openAttempts = opts.openAttempts ?? 8;
    this._openRetryMs = opts.openRetryMs ?? 500;
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
      // M3-C-L F1: retry pmOpenSession with backoff (default 8 x 500 ms) —
      // the standalone service takes ~2.5 s to be ready for a session; a
      // first-poll SERVICE_ERROR is transient, not a dead service. Only
      // when EVERY attempt failed do we declare the client unavailable.
      let st = PM_STATUS.FAILURE;
      for (let attempt = 1; attempt <= this._openAttempts; attempt++) {
        st = this._lib.pmOpenSession(sessionBuf);
        if (st === PM_STATUS.SUCCESS) break;
        if (attempt < this._openAttempts) await this._sleep(this._openRetryMs);
      }
      if (st !== PM_STATUS.SUCCESS) {
        this.available = false;
        this.availableReason = `PresentMon service unavailable (${describePmStatus(st)}) after ${this._openAttempts} attempts`;
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

  /**
   * M3-C-L: re-track a DIFFERENT pid on the SAME session/query (focus
   * change): stop tracking the old pid, start the new. The frame query is
   * per-pid (pmConsumeFrames takes the pid), so the registered query
   * survives the switch. Returns { ok: false, reason } when the new pid
   * cannot be tracked (the previous target stays active).
   *
   * M3-C step-5 F2: on a start FAILURE the old tracking is already stopped
   * but this._pid must NOT keep naming the old pid — poll() would otherwise
   * keep calling pmConsumeFrames for a pid the session no longer tracks and
   * silently read null until the next focus change. Reset this._pid to null
   * so the adapter's next poll re-resolves the foreground pid and retries
   * the start against a clean client state.
   * @param {number} pid
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async retarget(pid) {
    if (!this._session || !this._query || !this._lib) {
      return { ok: false, reason: this.available ? 'not started' : this.availableReason };
    }
    if (pid === this._pid) return { ok: true };
    try {
      if (this._pid !== null && this._pid !== undefined) {
        try { this._lib.pmStopTrackingProcess(this._session, this._pid); } catch { /* best effort */ }
      }
      const st = this._lib.pmStartTrackingProcess(this._session, pid);
      if (st !== PM_STATUS.SUCCESS) {
        // M3-C step-5 F2: the old tracking is gone; never claim to track the
        // old pid. A null pid makes the next poll re-resolve + retry.
        this._pid = null;
        return { ok: false, reason: `pmStartTrackingProcess(${pid}) -> ${describePmStatus(st)}` };
      }
      this._pid = pid;
      return { ok: true };
    } catch (err) {
      this._pid = null;
      return { ok: false, reason: `PresentMon retarget error: ${err.message}` };
    }
  }
}

export function describePmStatus(code) {
  return `${PM_STATUS_NAME[code] ?? 'UNKNOWN'} (${code})`;
}

/**
 * M3-C-L FPS adapter for the IPC layer: single lazy client + the PresentMon
 * service lifecycle + FOREGROUND-WINDOW pid tracking.
 *
 * On the first poll the adapter spawns the bundled PresentMonService
 * standalone (session-local shm prefix — feasibility verdict) and starts
 * the client tracking the CURRENT foreground pid. Every poll re-resolves
 * the foreground pid and RETARGETS the client on a focus change (stop old
 * pid, start new) — the app's own pid is never the target (it presents
 * nothing); when the desktop is focused, tracking moves back to the own pid
 * so stale frames from a backgrounded game are not reported. A failed
 * spawn/session leaves the adapter permanently unavailable and every poll
 * returns null — never throws. `stop` is best-effort (closes the session +
 * kills the spawned service) and resets the start latch.
 *
 * M3-C-L F1 (review): the first-poll start is RETRIED with backoff
 * (default 5 x 500 ms) so a transient start failure — the service still
 * coming up, a slow first pmOpenSession — never permanently latches FPS
 * off for the session. The foreground pid is RE-RESOLVED on every attempt
 * (a pid can exit between resolve and pmStartTrackingProcess -> INVALID_PID
 * with `available` still true); when the retries are exhausted in that
 * state, the client is dropped and the start latch reset so the next poll
 * retries against a fresh pid. A client that declares itself PERMANENTLY
 * unavailable (missing DLL / exhausted open-session retries) is not
 * retried: it can never succeed.
 * @param {{
 *   client?: PresentMonClient,
 *   createClient?: () => PresentMonClient,  // used when `client` is null
 *                                          // (the initial poll / after stop)
 *   resolvePid?: () => number | null,       // injectable foreground-pid helper
 *   spawnService?: (deps?: object) => { child: object | null, reason?: string },
 *   startAttempts?: number,                 // first-poll start retry count
 *   startRetryMs?: number,                  // backoff between start attempts
 *   sleep?: (ms: number) => Promise<void>,  // injectable sleep (tests)
 *   log?: (s: string) => void,
 * }} [opts]
 */
export function createPresentmonAdapter(opts = {}) {
  const ownPid = process.pid;
  const resolvePid = opts.resolvePid ?? resolveForegroundPid;
  const spawnService = opts.spawnService ?? spawnPresentMonService;
  const createClient = opts.createClient ?? (() => new PresentMonClient());
  const startAttempts = opts.startAttempts ?? 5;
  const startRetryMs = opts.startRetryMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  let client = opts.client ?? null;
  let serviceChild = null;
  let started = false;
  let currentPid = null;

  const startService = () => {
    if (serviceChild !== null) return;
    const out = spawnService();
    serviceChild = out.child ?? null;
    if (!serviceChild) log(`[presentmon] service not started: ${out.reason}`);
  };

  return {
    /**
     * @param {number} deviceId
     * @returns {Promise<{ fps: number | null, frameTimeMs: number | null, gpuBusy: number | null } | null>}
     */
    async poll(deviceId) {
      if (!started) {
        started = true;
        try {
          startService();
          if (!client) client = createClient();
          // M3-C-L: the initial target is the CURRENT foreground pid — never
          // the app's own pid (it presents nothing). With no foreground
          // window, track the own pid until a real foreground appears.
          let lastOut = null;
          // M3-C-L F1: retry the start with backoff. A client that reports
          // `available === false` (missing DLL / its own open-session
          // retries exhausted) is permanent — stop early, never burn the
          // backoff on a failure that cannot become success.
          for (let attempt = 1; attempt <= startAttempts; attempt++) {
            // M3-C-L F1 (round 2): re-resolve the foreground pid on EVERY
            // attempt. The pid resolved at loop entry can exit between
            // resolvePid() and pmStartTrackingProcess; retrying the same
            // dead pid can never succeed (INVALID_PID on every attempt).
            const fg = resolvePid();
            const target = fg !== null && fg !== ownPid ? fg : ownPid;
            try {
              lastOut = await client.start(deviceId, target);
              if (lastOut.ok) {
                currentPid = target;
                break;
              }
              if (client.available === false) break;
              log(`[presentmon] start attempt ${attempt}/${startAttempts} failed: ${lastOut.reason}`);
            } catch (err) {
              lastOut = { ok: false, reason: err.message };
              log(`[presentmon] start attempt ${attempt}/${startAttempts} threw: ${err.message}`);
            }
            if (attempt < startAttempts) await sleep(startRetryMs);
          }
          if (!lastOut?.ok) {
            // M3-C-L F1 (round 2): with the start attempts EXHAUSTED and the
            // client still nominally available (e.g. every attempt raced a
            // dead foreground pid — a pmStartTrackingProcess -> INVALID_PID
            // failure does not flip `available`), the failure is transient.
            // Drop the client AND reset the latch so the next poll re-enters
            // this block against a fresh pid; leaving the latch set would
            // make every later poll return null — FPS dead for the session.
            // A client reporting `available === false` is permanent (it can
            // never succeed) and keeps the latch set.
            const permanent = client.available === false;
            client = null;
            if (!permanent) started = false;
            return null;
          }
          log(`[presentmon] tracking foreground pid ${currentPid}`);
        } catch {
          client = null;
          started = false;
          return null;
        }
      }
      if (!client) return null;
      // M3-C-L: re-resolve the foreground pid every poll; retarget on focus
      // change. The desktop (null) or the app itself moves tracking back to
      // the own pid so stale frames are never reported.
      const fg = resolvePid();
      const wanted = fg !== null && fg !== ownPid ? fg : ownPid;
      if (wanted !== currentPid) {
        const out = await client.retarget(wanted);
        if (out.ok) {
          currentPid = wanted;
          log(`[presentmon] foreground changed -> pid ${wanted}`);
        }
      }
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
      if (serviceChild) {
        try { serviceChild.kill(); } catch { /* best effort */ }
        serviceChild = null;
      }
      started = false;
      currentPid = null;
    },
  };
}
