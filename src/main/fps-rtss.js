// Arc Power - native RTSS FPS/frametime provider.
//
// RTSS publishes per-process statistics through the read-only
// RTSSSharedMemoryV2 mapping. This module deliberately reads that mapping
// instead of using an ETW sidecar: the native RTSS values are
// the source of truth for the FPS and frametime rows in Arc Power's overlay.
// Missing RTSS, an unsupported mapping, and a game which RTSS cannot hook all
// degrade to null so the existing DXGI provider can answer honestly.

import koffi from 'koffi';

export const RTSS_MAPPING_NAME = 'RTSSSharedMemoryV2';
export const RTSS_SIGNATURE = 0x52545353; // MSVC multicharacter constant 'RTSS'; LE memory bytes are SSTR
export const RTSS_DEAD_SIGNATURE = 0x0000DEAD;
export const RTSS_MIN_VERSION = 0x00020000;
export const RTSS_FRAME_TIME_VERSION = 0x00020005;
export const RTSS_API_FLAGS_VERSION = 0x0002000A;
export const RTSS_MAX_APP_ENTRIES = 256;
export const RTSS_MAX_ENTRY_SIZE = 64 * 1024;
export const RTSS_MAX_MAPPING_BYTES = 64 * 1024 * 1024;
export const RTSS_MAX_INTERVAL_MS = 60_000;
export const RTSS_STALE_AFTER_MS = 1_500;

export const RTSS_HEADER_OFFSETS = Object.freeze({
  signature: 0,
  version: 4,
  appEntrySize: 8,
  appArrOffset: 12,
  appArrSize: 16,
});

// RTSS_SHARED_MEMORY_APP_ENTRY. The application array is intentionally
// addressed using the header's appEntrySize/appArrOffset values; these are
// only the field offsets within one entry and remain stable across RTSS 2.x.
export const RTSS_APP_OFFSETS = Object.freeze({
  processId: 0,
  name: 4,
  nameLength: 260,
  flags: 264,
  time0: 268,
  time1: 272,
  frames: 276,
  frameTimeUs: 280,
  statFrameRateAvg: 308,
  statFrameTimeCount: 920,
  statFrameTimeBuffer: 924,
  statFrameTimeBufferLength: 1024,
});

export const RTSS_FILE_MAP_READ = 0x0004;

const API_IDS = Object.freeze({
  OGL: 0x0001,
  DD: 0x0002,
  D3D8: 0x0003,
  D3D9: 0x0004,
  D3D9EX: 0x0005,
  D3D10: 0x0006,
  D3D11: 0x0007,
  D3D12: 0x0008,
  D3D12AFR: 0x0009,
  VULKAN: 0x000A,
});

const validNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function hasKnownByteLength(byteLength) {
  return Number.isSafeInteger(byteLength) && byteLength >= 0;
}

function readBounded(read, offset, size, byteLength) {
  if (!Number.isSafeInteger(offset) || offset < 0
    || (hasKnownByteLength(byteLength) && offset + size > byteLength)) {
    throw new RangeError('RTSS mapping read is outside the mapped view');
  }
  return read(offset);
}

function inferredViewLength(view) {
  if (view && (ArrayBuffer.isView(view) || view instanceof ArrayBuffer)) return view.byteLength;
  return null;
}

function rounded(value, places = 1) {
  if (!validNumber(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function versionAtLeast(version, required) {
  return Number.isInteger(version) && (version >>> 0) >= required;
}

function apiIdOf(flags, version) {
  // RTSS changed the low-word API flag values in v2.10. Older versions are
  // still valid FPS providers, but their legacy bitmask cannot be mapped
  // without risking a false API label in the overlay.
  if (!versionAtLeast(version, RTSS_API_FLAGS_VERSION)) return null;
  switch ((flags >>> 0) & 0xFFFF) {
    case API_IDS.OGL: return 'opengl';
    // The renderer intentionally exposes the same stable API vocabulary as
    // the existing fallback detector; legacy DirectDraw/D3D8 runtimes stay
    // visible without inventing a new overlay label.
    case API_IDS.DD:
    case API_IDS.D3D8: return 'other';
    case API_IDS.D3D9:
    case API_IDS.D3D9EX: return 'dx9';
    case API_IDS.D3D10: return 'dx10';
    case API_IDS.D3D11: return 'dx11';
    case API_IDS.D3D12:
    case API_IDS.D3D12AFR: return 'dx12';
    case API_IDS.VULKAN: return 'vulkan';
    default: return null;
  }
}

function frameStatsOf(frameTimesUs) {
  const times = frameTimesUs
    .filter((value) => validNumber(value) && value > 0 && value <= 60_000_000)
    .sort((a, b) => a - b);
  if (times.length === 0) return { avgFps: null, low1Pct: null, low01Pct: null, p99: null };

  const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
  const avgFps = rounded(1_000_000 / mean, 0);
  if (times.length < 60) return { avgFps, low1Pct: null, low01Pct: null, p99: null };

  // Match the overlay's existing percentile convention: frame times are
  // sorted from fastest to slowest, then converted back into FPS.
  const p99Index = Math.max(1, Math.ceil(times.length * 0.99)) - 1;
  const p99 = rounded(1_000_000 / times[p99Index], 0);
  const tail = times.slice(p99Index);
  const low1Pct = rounded(1_000_000 / (tail.reduce((sum, value) => sum + value, 0) / tail.length), 0);
  let low01Pct = null;
  if (times.length >= 300) {
    const low01Index = Math.max(1, Math.ceil(times.length * 0.999)) - 1;
    const low01Tail = times.slice(low01Index);
    low01Pct = rounded(1_000_000 / (low01Tail.reduce((sum, value) => sum + value, 0) / low01Tail.length), 0);
  }
  return { avgFps, low1Pct, low01Pct, p99 };
}

function readAnsi(readByte, offset, length) {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    const value = readByte(offset + index);
    if (!Number.isInteger(value) || value === 0) break;
    // RTSS stores the executable name as an ANSI string. Keep control
    // characters out of the diagnostic-only name returned by this parser.
    if (value >= 0x20 && value !== 0x7F) text += String.fromCharCode(value);
  }
  return text;
}

function elapsedTickMs(time0, time1) {
  if (!Number.isInteger(time0) || !Number.isInteger(time1) || time0 === 0 || time1 === 0) return null;
  const elapsed = (time1 - time0) >>> 0;
  return elapsed > 0 && elapsed <= RTSS_MAX_INTERVAL_MS ? elapsed : null;
}

/**
 * Parse the versioned RTSS header and reject malformed/uninitialized maps.
 * `readUint32` is deliberately injected so this function is testable with a
 * Buffer and does not make tests load kernel32.dll.
 *
 * @param {(offset: number) => number} readUint32
 * @returns {{ version: number, appEntrySize: number, appArrOffset: number, appArrSize: number }|null}
 */
export function readRtssHeader(readUint32, byteLength = null) {
  try {
    if (hasKnownByteLength(byteLength) && byteLength < 20) return null;
    const signature = readUint32(RTSS_HEADER_OFFSETS.signature) >>> 0;
    const version = readUint32(RTSS_HEADER_OFFSETS.version) >>> 0;
    const appEntrySize = readUint32(RTSS_HEADER_OFFSETS.appEntrySize) >>> 0;
    const appArrOffset = readUint32(RTSS_HEADER_OFFSETS.appArrOffset) >>> 0;
    const appArrSize = readUint32(RTSS_HEADER_OFFSETS.appArrSize) >>> 0;
    if (signature !== RTSS_SIGNATURE || signature === RTSS_DEAD_SIGNATURE) return null;
    if (!versionAtLeast(version, RTSS_MIN_VERSION)) return null;
    const appArrayEnd = appArrOffset + (appEntrySize * appArrSize);
    if (appEntrySize < RTSS_APP_OFFSETS.statFrameRateAvg + 4
      || appEntrySize > RTSS_MAX_ENTRY_SIZE
      || appArrOffset < 20
      || appArrSize < 1
      || appArrSize > RTSS_MAX_APP_ENTRIES
      || !Number.isSafeInteger(appArrayEnd)
      || appArrayEnd > RTSS_MAX_MAPPING_BYTES
      || (hasKnownByteLength(byteLength) && appArrayEnd > byteLength)) return null;
    return { version, appEntrySize, appArrOffset, appArrSize };
  } catch {
    return null;
  }
}

function readEntry(readUint32, readByte, header, index) {
  const base = header.appArrOffset + (index * header.appEntrySize);
  const processId = readUint32(base + RTSS_APP_OFFSETS.processId) >>> 0;
  if (processId === 0) return null;
  const time0 = readUint32(base + RTSS_APP_OFFSETS.time0) >>> 0;
  const time1 = readUint32(base + RTSS_APP_OFFSETS.time1) >>> 0;
  const frames = readUint32(base + RTSS_APP_OFFSETS.frames) >>> 0;
  const frameTimeUs = readUint32(base + RTSS_APP_OFFSETS.frameTimeUs) >>> 0;
  return {
    base,
    processId,
    name: readAnsi(readByte, base + RTSS_APP_OFFSETS.name, RTSS_APP_OFFSETS.nameLength),
    flags: readUint32(base + RTSS_APP_OFFSETS.flags) >>> 0,
    time0,
    time1,
    frames,
    frameTimeUs,
    statFrameRateAvg: readUint32(base + RTSS_APP_OFFSETS.statFrameRateAvg) >>> 0,
  };
}

/**
 * Read one target process from an RTSS mapping.
 *
 * @param {(offset: number) => number} readUint32
 * @param {(offset: number) => number} readByte
 * @param {{ processId: number, processName?: string|null }} target
 * @returns {{ sample: object, token: string, processId: number, name: string, version: number }|null}
 */
export function readRtssSnapshot(readUint32, readByte, target, options = {}) {
  try {
    const byteLength = options?.byteLength ?? null;
    const boundedUint32 = (offset) => readBounded(readUint32, offset, 4, byteLength) >>> 0;
    const boundedByte = (offset) => readBounded(readByte, offset, 1, byteLength) & 0xFF;
    const header = readRtssHeader(boundedUint32, byteLength);
    if (!header || !Number.isInteger(target?.processId) || target.processId < 1) return null;

  let entry = null;
  for (let index = 0; index < header.appArrSize; index += 1) {
    const candidate = readEntry(boundedUint32, boundedByte, header, index);
    if (candidate && candidate.processId === target.processId) {
      entry = candidate;
      break;
    }
  }
  if (!entry && typeof target.processName === 'string' && target.processName.length > 0) {
    for (let index = 0; index < header.appArrSize; index += 1) {
      const candidate = readEntry(boundedUint32, boundedByte, header, index);
      if (candidate && candidate.name.toLowerCase() === target.processName.toLowerCase()) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return null;

  // Read the changing counters again. If RTSS is in the middle of updating
  // the entry, leave this poll unavailable instead of mixing two snapshots.
  const second = readEntry(boundedUint32, boundedByte, header, entry.base - header.appArrOffset < 0
    ? 0
    : Math.floor((entry.base - header.appArrOffset) / header.appEntrySize));
  if (!second
    || second.processId !== entry.processId
    || second.time0 !== entry.time0
    || second.time1 !== entry.time1
    || second.frames !== entry.frames
    || second.frameTimeUs !== entry.frameTimeUs) return null;
  entry = second;

  const elapsedMs = elapsedTickMs(entry.time0, entry.time1);
  const intervalFps = elapsedMs !== null && entry.frames > 0
    ? (1000 * entry.frames) / elapsedMs
    : null;
  const instantFps = entry.frameTimeUs > 0 ? 1_000_000 / entry.frameTimeUs : null;
  const fps = validNumber(intervalFps) && intervalFps > 0 ? intervalFps : instantFps;
  if (!validNumber(fps) || fps <= 0 || fps > 100_000) return null;

  const frameTimesUs = [];
  if (versionAtLeast(header.version, RTSS_FRAME_TIME_VERSION)
    && header.appEntrySize >= RTSS_APP_OFFSETS.statFrameTimeBuffer
      + (RTSS_APP_OFFSETS.statFrameTimeBufferLength * 4)) {
    const count = Math.min(
      boundedUint32(entry.base + RTSS_APP_OFFSETS.statFrameTimeCount) >>> 0,
      RTSS_APP_OFFSETS.statFrameTimeBufferLength,
    );
    for (let index = 0; index < count; index += 1) {
      const value = boundedUint32(entry.base + RTSS_APP_OFFSETS.statFrameTimeBuffer + (index * 4)) >>> 0;
      if (value > 0) frameTimesUs.push(value);
    }
  }
  const computed = frameStatsOf(frameTimesUs);
  const nativeAverage = entry.statFrameRateAvg > 0 ? entry.statFrameRateAvg : null;
  const token = [entry.time0, entry.time1, entry.frames, entry.frameTimeUs].join(':');
    return {
      sample: {
        fps: rounded(fps, 1),
        frameTimeMs: entry.frameTimeUs > 0 ? rounded(entry.frameTimeUs / 1000, 3) : rounded(1000 / fps, 3),
        gpuBusy: null,
        avgFps: nativeAverage ?? computed.avgFps,
        low1Pct: computed.low1Pct,
        low01Pct: computed.low01Pct,
        p99: computed.p99,
        api: apiIdOf(entry.flags, header.version),
      },
      token,
      processId: entry.processId,
      name: entry.name,
      version: header.version,
    };
  } catch {
    return null;
  }
}

function defaultBindings() {
  if (process.platform !== 'win32') return null;
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const virtualQuery = kernel32.func('VirtualQuery', 'size_t', ['void*', 'void*', 'size_t']);
    const pointerSize = process.arch === 'x64' || process.arch === 'arm64' ? 8 : 4;
    const querySize = pointerSize === 8 ? 48 : 28;
    const regionSizeOffset = pointerSize === 8 ? 24 : 12;
    const pointerType = pointerSize === 8 ? 'uint64' : 'uint32';
    const getViewLength = (view) => {
      try {
        const info = Buffer.alloc(querySize);
        const result = Number(virtualQuery(view, info, querySize));
        if (!Number.isFinite(result) || result < querySize) return null;
        const viewAddress = BigInt(koffi.address(view));
        const regionBase = BigInt(koffi.decode(info, 0, pointerType));
        const regionSize = BigInt(koffi.decode(info, regionSizeOffset, pointerType));
        const regionEnd = regionBase + regionSize;
        if (regionSize <= 0n || viewAddress < regionBase || viewAddress >= regionEnd) return null;
        const remaining = regionEnd - viewAddress;
        return remaining > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(remaining);
      } catch {
        return null;
      }
    };
    return {
      openMapping: kernel32.func('OpenFileMappingW', 'void*', ['uint32', 'bool', 'str16']),
      mapView: ((mapView) => (handle, access) => mapView(handle, access, 0, 0, 0))(
        kernel32.func('MapViewOfFile', 'void*', ['void*', 'uint32', 'uint32', 'uint32', 'size_t']),
      ),
      unmapView: kernel32.func('UnmapViewOfFile', 'int32', ['void*']),
      closeHandle: kernel32.func('CloseHandle', 'int32', ['void*']),
      getViewLength,
      requireViewLength: true,
    };
  } catch {
    return null;
  }
}

function validHandle(handle) {
  return handle !== null && handle !== undefined && handle !== 0 && handle !== 0n;
}

/**
 * Create the lazy read-only RTSS source. The optional native seams are also
 * used by the unit tests, where `view` can be a Buffer containing a crafted
 * RTSS mapping.
 *
 * @param {{
 *   openMapping?: (access: number, inheritHandle: boolean, name: string) => unknown,
 *   mapView?: (handle: unknown) => unknown,
 *   unmapView?: (view: unknown) => void,
 *   closeHandle?: (handle: unknown) => void,
 *   readUint32?: (view: unknown, offset: number) => number,
 *   readByte?: (view: unknown, offset: number) => number,
 *   getViewLength?: (view: unknown) => number|null,
 *   now?: () => number,
 *   staleAfterMs?: number,
 * }} [deps]
 */
export function createRtssFpsSource(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const staleAfterMs = Number.isFinite(deps.staleAfterMs) ? Math.max(250, deps.staleAfterMs) : RTSS_STALE_AFTER_MS;
  let view = null;
  let viewLength = null;
  let handle = null;
  let bindings = null;
  let lastObservation = null;

  const getBindings = () => {
    if (bindings !== null) return bindings;
    bindings = deps.openMapping && deps.mapView
      ? {
          openMapping: deps.openMapping,
          mapView: deps.mapView,
          unmapView: deps.unmapView ?? (() => {}),
          closeHandle: deps.closeHandle ?? (() => {}),
          getViewLength: deps.getViewLength ?? inferredViewLength,
          requireViewLength: false,
        }
      : defaultBindings();
    return bindings;
  };

  const closeMapping = () => {
    const current = getBindings();
    if (view !== null) {
      try { current?.unmapView?.(view); } catch { /* best effort */ }
    }
    if (validHandle(handle)) {
      try { current?.closeHandle?.(handle); } catch { /* best effort */ }
    }
    view = null;
    viewLength = null;
    handle = null;
    lastObservation = null;
  };

  const ensureMapping = () => {
    if (view !== null) return true;
    const current = getBindings();
    if (!current) return false;
    try {
      handle = current.openMapping(RTSS_FILE_MAP_READ, false, RTSS_MAPPING_NAME);
      if (!validHandle(handle)) {
        handle = null;
        return false;
      }
      view = current.mapView(handle, RTSS_FILE_MAP_READ);
      if (view === null || view === undefined || view === 0 || view === 0n) {
        current.closeHandle?.(handle);
        handle = null;
        view = null;
        return false;
      }
      viewLength = current.getViewLength?.(view) ?? null;
      if (current.requireViewLength && !hasKnownByteLength(viewLength)) {
        closeMapping();
        return false;
      }
      return true;
    } catch {
      closeMapping();
      return false;
    }
  };

  const readUint32 = (offset) => {
    if (deps.readUint32) return deps.readUint32(view, offset) >>> 0;
    return koffi.decode(view, offset, 'uint32') >>> 0;
  };
  const readByte = (offset) => {
    if (deps.readByte) return deps.readByte(view, offset) & 0xFF;
    return koffi.decode(view, offset, 'uint8') & 0xFF;
  };

  return {
    async poll(processId) {
      if (!Number.isInteger(processId) || processId < 1 || !ensureMapping()) return null;
      try {
        const snapshot = readRtssSnapshot(readUint32, readByte, { processId }, { byteLength: viewLength });
        if (!snapshot) {
          // A valid mapping with no matching application is normal while the
          // game is starting. Reopen only when the header itself is invalid;
          // that keeps the source cheap during ordinary no-game polls.
          if (!readRtssHeader(readUint32, viewLength)) closeMapping();
          return null;
        }
        const at = now();
        if (!lastObservation || lastObservation.processId !== snapshot.processId || lastObservation.token !== snapshot.token) {
          lastObservation = { processId: snapshot.processId, token: snapshot.token, changedAt: at };
        } else if (at - lastObservation.changedAt > staleAfterMs) {
          return null;
        }
        return snapshot.sample;
      } catch {
        closeMapping();
        return null;
      }
    },

    async stop() {
      closeMapping();
    },
  };
}

/**
 * Wrap the source with the same foreground-process ownership boundary that
 * the previous FPS lane used. The `deviceId` is intentionally ignored:
 * RTSS owns process identity, while GPU telemetry keeps its durable GPU-key
 * routing independently.
 */
export function createRtssFpsLane({
  source = createRtssFpsSource(),
  resolveForegroundPid = async () => null,
  isOwnPid = async () => false,
  isPidAlive = async (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  },
  now = () => Date.now(),
  targetRetentionMs = 5_000,
} = {}) {
  const retentionMs = Number.isFinite(targetRetentionMs) ? Math.max(250, targetRetentionMs) : 5_000;
  let lastTarget = null;
  return {
    async poll(_deviceId) {
      let pid = null;
      try { pid = await resolveForegroundPid(); } catch { return null; }
      if (!Number.isInteger(pid) || pid < 1) return null;
      try {
        if (await isOwnPid(pid)) {
          const retained = lastTarget && now() - lastTarget.at <= retentionMs
            && await isPidAlive(lastTarget.pid);
          if (!retained) {
            lastTarget = null;
            return null;
          }
          pid = lastTarget.pid;
        } else {
          lastTarget = { pid, at: now() };
        }
      } catch {
        return null;
      }
      try { return await source.poll(pid); } catch { return null; }
    },

    async stop() {
      await source.stop?.();
    },
  };
}
