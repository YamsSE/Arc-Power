// Arc Power - M17d the PresentMon service PM_QUERY_ELEMENT layout decode
// (pure, DOM-free; unit-tested in test/pure-fps-pm-layout.test.ts - the
// cheap-oracle seam of the Run-C service lane).
//
// The driver-shipped PresentMonAPI2.dll (the PresentMon v2.5.1 merge-
// module generation, API 3.3 - the exact generation the plan pins and the
// dev-box DLL v2.5.0.0; cross-checked against the upstream main-branch
// API 3.4 header) exposes the pm* service surface: a dynamic query
// registers an array of PM_QUERY_ELEMENT descriptors and
// pmPollDynamicQuery writes one value per element into a caller-owned
// BYTE blob laid out by each element's dataOffset/dataSize. This module
// owns the layout math + the enums, so the koffi bindings in the main
// lane only marshal raw bytes.
//
// THE LAYOUT IS THE MIDDLEWARE'S (the caller's offsets are overwritten):
// the PresentMon v2.5.1 middleware recomputes every element's layout at
// register time (DynamicQuery.cpp:159-163 - qel.dataOffset = blobCursor;
// the element data size comes from the stat/polled-type output type; the
// offset is aligned UP to that size) and pads the whole blob to 16 bytes
// (DynamicQuery.cpp:205-206 - "make sure blob sizes are multiple of 16
// bytes for blob array alignment purposes"; blobSize_ =
// PadToAlignment(blobCursor, 16)). The poll then writes ONE padded blob
// per swap chain (DynamicQuery.cpp:438-447 - pBlobBase += blobSize_) and
// the caller MUST pre-encode *numSwapChains = the max its blob holds (an
// input of 0 -> PM_STATUS_BAD_ARGUMENT, PresentMonAPI.cpp:357-360). This
// module mirrors that math exactly so the descriptors the koffi side
// marshals match the offsets the middleware computes + the blob the lane
// allocates is the middleware's padded stride.
//
// THE DRY-STREAM SIGNAL (M17d step-4 S1): API 3.3's pmPollDynamicQuery
// has NO output timestamp, and PM_STAT_COUNT is NOT a supported dynamic
// query stat in v2.5.1 (QueryValidation.cpp rejects it), so there is no
// count element either. The service itself IS the dry signal: the dynamic
// AVG accumulator is reset after every poll (DynamicStat.cpp:94-101), so
// a poll whose window holds no new frames writes AVG = 0.0. The reader
// therefore REJECTS a <= 0 fps (below) - a dry poll decodes
// displayedFps null and the lane keeps lastGood unstamped (the at-gate
// ages it out, exactly like the sidecar's newestTs dry signal).
//
// ENUM VALUES (pinned from PresentMonAPI.h - the vendored PresentMon
// v2.5.1 generation, API 3.3; cross-checked against the upstream main
// branch PresentMonAPI.h v3.4 - the values are stable append-only):
//   PM_METRIC:        DISPLAYED_FPS = 11, PRESENTED_FPS = 12,
//                     PRESENT_MODE = 20, PRESENT_RUNTIME = 21;
//   PM_STAT:          AVG = 1, PERCENTILE_99 = 2, NEWEST_POINT = 12,
//                     COUNT = 14;
//   PM_GRAPHICS_RUNTIME: UNKNOWN = 0, DXGI = 1, D3D9 = 2.
//
// PM_QUERY_ELEMENT struct layout (x64, the default ABI alignment - the
// koffi struct the bindings use):
//   metric      int32  @ 0
//   stat        int32  @ 4
//   deviceId    uint32 @ 8
//   arrayIndex  uint32 @ 12
//   dataOffset  uint64 @ 16
//   dataSize    uint64 @ 24
//   total size = 32 bytes. The poll blob's per-element value sits at the
//   element's dataOffset; the value size is the METRIC/STAT output type
//   (double = 8 bytes for the fps AVG/NEWEST_POINT, int32 = 4 bytes for
//   the enum metrics like PRESENT_RUNTIME / PRESENT_MODE).
//
// The reader is DEFENSIVE: a garbage blob / an offset outside the blob /
// an out-of-range enum / a non-finite, zero or negative fps -> null (the
// lane degrades to the last-good rate, never a crash, never an invented
// fps).

/** PM_METRIC values (PresentMonAPI.h - the fps/API-class metrics this
 *  module reads). */
export const PM_METRIC = Object.freeze({
  DISPLAYED_FPS: 11, // "rate of frame change measurable at display" - what IGS shows
  PRESENTED_FPS: 12, // the Present() call rate
  PRESENT_MODE: 20, // the flip model (PM_PRESENT_MODE)
  PRESENT_RUNTIME: 21, // the API class (PM_GRAPHICS_RUNTIME)
} as const);

/** PM_STAT values (PresentMonAPI.h - the statistics the query asks the
 *  service to compute). */
export const PM_STAT = Object.freeze({
  AVG: 1, // PM_STAT_AVG - the ~500 ms window average the lane uses
  PERCENTILE_99: 2, // PM_STAT_PERCENTILE_99
  NEWEST_POINT: 12, // PM_STAT_NEWEST_POINT - the newest frame's value
  COUNT: 14, // PM_STAT_COUNT - the number of frames in the window
} as const);

/** PM_GRAPHICS_RUNTIME values (PresentMonAPI.h - the per-present API class
 *  the PRESENT_RUNTIME metric reports; Vulkan/OpenGL = Other by design -
 *  the module-scan badge keeps the fine grain). */
export const PM_GRAPHICS_RUNTIME = Object.freeze({
  UNKNOWN: 0,
  DXGI: 1,
  D3D9: 2,
} as const);

/** The per-metric poll value size in bytes (the metric's data type: the
 *  fps metrics are doubles, the enum metrics int32). */
export function pmMetricDataSize(metric: number): number {
  return metric === PM_METRIC.PRESENT_RUNTIME || metric === PM_METRIC.PRESENT_MODE ? 4 : 8;
}

/** The middleware's PadToAlignment (DynamicQuery.cpp - each element's
 *  offset aligns up to its data size; the whole blob pads to 16). */
function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** One PM_QUERY_ELEMENT descriptor with the computed blob layout. */
export interface PmQueryElement {
  metric: number;
  stat: number;
  deviceId: number;
  arrayIndex: number;
  dataOffset: number;
  dataSize: number;
}

/**
 * M17d: build the PM_QUERY_ELEMENT array + the poll-blob size for a query
 * - the pure layout math (the koffi side just marshals the descriptors).
 * The math mirrors the PresentMon v2.5.1 MIDDLEWARE exactly - the
 * middleware overwrites the caller's offsets at register time
 * (DynamicQuery.cpp:159-163): each element's dataOffset is the running
 * blob cursor ALIGNED UP to the element's data size, and the final
 * blobSize is the whole layout PADDED to 16 bytes (DynamicQuery.cpp:205-
 * 206 - the per-swap-chain blob stride the poll writes; a caller allocates
 * blobSize bytes per swap chain it can hold). The lane requests exactly 1
 * swap chain, so its blob = blobSize.
 * @param {Array<{ metric: number, stat: number, deviceId?: number,
 *   arrayIndex?: number }>} elements the query elements (metric + stat;
 *   deviceId/arrayIndex default 0 - the single-adapter case)
 * @returns {{ elements: PmQueryElement[], blobSize: number }} blobSize =
 *   the 16-ALIGNED blob size (the middleware's per-swap-chain stride)
 */
export function pmQueryElements(elements: Array<{
  metric: number;
  stat: number;
  deviceId?: number;
  arrayIndex?: number;
}>): { elements: PmQueryElement[]; blobSize: number } {
  let cursor = 0;
  const out: PmQueryElement[] = [];
  for (const e of elements) {
    const dataSize = pmMetricDataSize(e.metric);
    const dataOffset = alignUp(cursor, dataSize);
    out.push({
      metric: e.metric,
      stat: e.stat,
      deviceId: e.deviceId ?? 0,
      arrayIndex: e.arrayIndex ?? 0,
      dataOffset,
      dataSize,
    });
    cursor = dataOffset + dataSize;
  }
  return { elements: out, blobSize: alignUp(cursor, 16) };
}

/** The decoded poll result shape (all null/absent when a metric was not
 *  registered or the blob carried no usable value for it). */
export interface PmPollResult {
  /** The display-cadence fps (the DISPLAYED_FPS metric - what IGS shows);
   *  null when not queried / garbage / a <= 0 rate (a 0 AVG is the
   *  service's dry-window answer - the lane's dry signal). */
  displayedFps: number | null;
  /** The Present() call-rate fps (the PRESENTED_FPS metric). */
  presentedFps: number | null;
  /** The API class of the newest frame (PM_GRAPHICS_RUNTIME - UNKNOWN /
   *  DXGI / D3D9; Vulkan/OpenGL = UNKNOWN by design). */
  presentRuntime: number | null;
  /** The flip-model enum of the newest frame (PM_PRESENT_MODE). */
  presentMode: number | null;
}

/**
 * M17d: read a pmPollDynamicQuery blob per the registered query elements -
 * the dataOffset/dataSize layout math in the defensive direction. Each
 * element's value is decoded at its dataOffset with its dataSize (a double
 * for the fps metrics, an int32 for the enum metrics); a garbage blob /
 * an out-of-bounds offset / a non-finite, ZERO or negative fps / an
 * out-of-range enum -> that field degrades to null (the honest absent -
 * never a crash, never an invented value). The ZERO rejection is the
 * dry-stream signal: API 3.3's plain poll has no output timestamp and
 * PM_STAT_COUNT is unsupported in v2.5.1, and the middleware writes the
 * AVG as 0.0 when the poll's window holds no new frames
 * (DynamicStat.cpp:94-101 - the accumulator resets every poll) - a 0 fps
 * blob IS the "no new present" answer, so the lane keeps lastGood
 * unstamped and the at-gate ages it out (ftMs = 1000/0 = Infinity would
 * also poison the percentiles ring - rejected for that reason too). A blob
 * with NO element whose metric is one of the four tracked ones -> null
 * (nothing to report).
 * @param {unknown} elements the PM_QUERY_ELEMENT descriptors (as built by
 *   pmQueryElements)
 * @param {unknown} blob the raw poll blob (Uint8Array / Buffer - the koffi
 *   decode result)
 * @returns {PmPollResult | null}
 */
export function pmReadPollBlob(elements: unknown, blob: unknown): PmPollResult | null {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  if (!blob || typeof blob !== 'object' || typeof (blob as { byteLength?: unknown }).byteLength !== 'number') return null;
  const bytes = blob as Uint8Array;
  if (bytes.byteLength <= 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const readDouble = (e: PmQueryElement): number | null => {
    if (e.dataSize !== 8 || e.dataOffset + 8 > bytes.byteLength) return null;
    const v = view.getFloat64(e.dataOffset, true);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const readInt32 = (e: PmQueryElement): number | null => {
    if (e.dataSize !== 4 || e.dataOffset + 4 > bytes.byteLength) return null;
    const v = view.getInt32(e.dataOffset, true);
    return Number.isFinite(v) ? v : null;
  };

  const out: PmPollResult = { displayedFps: null, presentedFps: null, presentRuntime: null, presentMode: null };
  let tracked = 0;
  for (const raw of elements) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as PmQueryElement;
    if (typeof e.metric !== 'number' || typeof e.dataOffset !== 'number' || typeof e.dataSize !== 'number') continue;
    switch (e.metric) {
      case PM_METRIC.DISPLAYED_FPS: {
        const v = readDouble(e);
        if (v !== null) { out.displayedFps = v; tracked++; }
        break;
      }
      case PM_METRIC.PRESENTED_FPS: {
        const v = readDouble(e);
        if (v !== null) { out.presentedFps = v; tracked++; }
        break;
      }
      case PM_METRIC.PRESENT_RUNTIME: {
        const v = readInt32(e);
        if (v !== null && v >= PM_GRAPHICS_RUNTIME.UNKNOWN && v <= PM_GRAPHICS_RUNTIME.D3D9) { out.presentRuntime = v; tracked++; }
        break;
      }
      case PM_METRIC.PRESENT_MODE: {
        const v = readInt32(e);
        if (v !== null && v >= 0 && v <= 8) { out.presentMode = v; tracked++; }
        break;
      }
      default:
        break; // untracked metrics are skipped (their values may be any type)
    }
  }
  return tracked > 0 ? out : null;
}
