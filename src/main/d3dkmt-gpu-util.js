// Native Windows GPU-node utilization reader.
//
// Windows Task Manager's GPU view is engine-oriented.  The public PDH
// GPU Engine counter is useful, but on some Intel drivers it can lag or
// under-report a busy 3D node.  D3DKMTQueryStatistics exposes the same
// scheduler running-time counters that Windows uses underneath.  This
// module keeps that undocumented-but-stable bridge isolated and fail-closed.

import koffi from 'koffi';

export const D3DKMT_QUERYSTATISTICS_SIZE = 0x328;
export const D3DKMT_QUERYSTATISTICS_ADAPTER = 0;
export const D3DKMT_QUERYSTATISTICS_NODE = 5;

// x64 layout from the Windows SDK d3dkmthk.h.  The SDK asserts the complete
// structure size as 0x328.  Keep the offsets together so a future SDK/layout
// audit has one small surface to review.
export const D3DKMT_OFFSETS = Object.freeze({
  type: 0x00,
  adapterLuidLow: 0x04,
  adapterLuidHigh: 0x08,
  processHandle: 0x10,
  queryResult: 0x18,
  adapterNodeCount: 0x1c,
  nodeGlobalRunningTime: 0x18,
  // D3DKMT_QUERYSTATISTICS_PROCESS_NODE_INFORMATION is 0x110 bytes in the
  // current x64 SDK: SystemInformation begins at QueryResult + 0x110.
  nodeSystemRunningTime: 0x128,
  queryNode: 0x320,
});

const RUNNING_TIME_TICKS_PER_MILLISECOND = 10_000n;
const MAX_SAMPLE_OVERRUN_PERCENT = 5n;
const MAX_NODE_COUNT = 256;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function uint32Part(value) {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= 0xffffffffn ? Number(value) >>> 0 : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
      ? value >>> 0
      : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const parsed = /^0x[0-9a-f]+$/i.test(text)
    ? Number.parseInt(text.slice(2), 16)
    : /^[0-9]+$/.test(text)
      ? Number(text)
      : /^[0-9a-f]+$/i.test(text)
        ? Number.parseInt(text, 16)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff
    ? parsed >>> 0
    : null;
}

export function normalizeD3dkmtLuid(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parts = value.trim().split(':');
    if (parts.length !== 2) return null;
    const high = uint32Part(parts[0]);
    const low = uint32Part(parts[1]);
    return high === null || low === null ? null : { high, low };
  }
  if (typeof value !== 'object') return null;
  const high = uint32Part(value.high ?? value.High ?? value.highPart ?? value.HighPart);
  const low = uint32Part(value.low ?? value.Low ?? value.lowPart ?? value.LowPart);
  return high === null || low === null ? null : { high, low };
}

function bigintCounter(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

function utilizationFromGlobalDelta(globalDelta, elapsedMs) {
  // GlobalInformation.RunningTime is accumulated node busy time in 100-ns
  // ticks. Use elapsed real time as the denominator. SystemInformation is
  // the system-thread counter, not the sampling interval; using it here can
  // turn a small system-thread delta into a false 100% node utilization.
  const wallTicks = BigInt(Math.max(1, Math.round(
    elapsedMs * Number(RUNNING_TIME_TICKS_PER_MILLISECOND),
  )));
  if (globalDelta > wallTicks) {
    // sampledAt is captured after the native query batch. Permit only a
    // small amount of timestamp skew; never clamp an arbitrary overrun into
    // a convincing-looking 100% sample.
    const overrunTicks = globalDelta - wallTicks;
    if (overrunTicks * 100n > wallTicks * MAX_SAMPLE_OVERRUN_PERCENT) return null;
    return 100;
  }
  const utilization = (Number(globalDelta) / Number(wallTicks)) * 100;
  return Number.isFinite(utilization) && utilization >= 0 && utilization <= 100
    ? utilization
    : null;
}

/**
 * Compute the adapter utilization from one native sample pair per node.
 *
 * GlobalInformation.RunningTime is the node's accumulated busy time. Its
 * denominator is the monotonic wall-clock interval between samples, expressed
 * in the same 100-ns units. SystemInformation.RunningTime is the system
 * thread's counter, not the sampling interval; it can advance much less than
 * the global counter and would create false 100% spikes. Samples that exceed
 * the wall-clock interval are inconsistent and rejected rather than clamped.
 * Missing or reset global counters are ignored; null means no trustworthy node
 * sample was available. A small overrun tolerance covers timestamp skew from
 * taking the timestamp after the native query batch; larger overruns are
 * rejected rather than clamped.
 */
export function d3dkmtUtilPctOf(previousNodes, currentNodes, elapsedMs) {
  if (!Array.isArray(previousNodes) || !Array.isArray(currentNodes)) return null;
  const elapsed = finiteNumber(elapsedMs);
  if (elapsed === null || elapsed <= 0) return null;

  const previousByNode = new Map(previousNodes.map((node) => [node.id, node]));
  let busiest = null;
  for (const current of currentNodes) {
    if (!Number.isInteger(current?.id)) continue;
    const previous = previousByNode.get(current.id);
    if (!previous) continue;
    const globalNow = bigintCounter(current.globalRunningTime);
    const globalBefore = bigintCounter(previous.globalRunningTime);
    if (globalNow === null || globalBefore === null || globalNow < globalBefore) continue;
    const globalDelta = globalNow - globalBefore;

    const utilization = utilizationFromGlobalDelta(globalDelta, elapsed);
    if (utilization !== null && (busiest === null || utilization > busiest)) {
      busiest = utilization;
    }
  }
  return busiest;
}

function defaultQueryFactory(load) {
  let query = null;
  let buffer = null;
  const ensure = () => {
    if (query && buffer) return;
    const gdi = load('gdi32.dll');
    query = gdi.func('D3DKMTQueryStatistics', 'int32', ['void*']);
    buffer = koffi.alloc('uint8', D3DKMT_QUERYSTATISTICS_SIZE);
    for (let i = 0; i < D3DKMT_QUERYSTATISTICS_SIZE; i++) koffi.encode(buffer, i, 'uint8', 0);
  };
  const queryStatistics = ({ type, luid, nodeId = 0 }) => {
    ensure();
    koffi.encode(buffer, D3DKMT_OFFSETS.type, 'uint32', type >>> 0);
    koffi.encode(buffer, D3DKMT_OFFSETS.adapterLuidLow, 'uint32', luid.low >>> 0);
    koffi.encode(buffer, D3DKMT_OFFSETS.adapterLuidHigh, 'uint32', luid.high >>> 0);
    // hProcess and all reserved/input bytes were zeroed at allocation. The
    // query union is overwritten for every node request.
    koffi.encode(buffer, D3DKMT_OFFSETS.queryNode, 'uint32', nodeId >>> 0);
    const status = query(buffer);
    if (status !== 0) return { status };
    if (type === D3DKMT_QUERYSTATISTICS_ADAPTER) {
      return {
        status,
        nodeCount: koffi.decode(buffer, D3DKMT_OFFSETS.adapterNodeCount, 'uint32'),
      };
    }
    return {
      status,
      globalRunningTime: koffi.decode(buffer, D3DKMT_OFFSETS.nodeGlobalRunningTime, 'uint64'),
      systemRunningTime: koffi.decode(buffer, D3DKMT_OFFSETS.nodeSystemRunningTime, 'uint64'),
    };
  };
  return queryStatistics;
}

/**
 * Create one serialized native sampler. Each physical LUID has its own node
 * baseline, so two Arc adapters cannot borrow one another's utilization.
 * `queryStatistics` and `now` are injectable for focused tests.
 */
export function createD3dkmtGpuUtilReader(options = {}) {
  const load = options.load ?? ((name) => koffi.load(name));
  const now = options.now ?? (() => performance.now());
  const queryStatistics = options.queryStatistics ?? defaultQueryFactory(load);
  const states = new Map();
  const inflight = new Map();
  const resetEpochs = new Map();
  let resetGeneration = 0;

  const keyOf = (luid) => `${luid.high >>> 0}:${luid.low >>> 0}`;
  const reset = (rawKey) => {
    const normalized = normalizeD3dkmtLuid(rawKey);
    const key = normalized
      ? keyOf(normalized)
      : typeof rawKey === 'string' && rawKey.trim()
        ? rawKey.trim()
        : null;
    if (key) {
      states.delete(key);
      resetEpochs.set(key, (resetEpochs.get(key) ?? 0) + 1);
    } else {
      states.clear();
      resetGeneration += 1;
    }
  };
  const epochOf = (key) => `${resetGeneration}:${resetEpochs.get(key) ?? 0}`;

  const sample = async (rawLuid) => {
    const luid = normalizeD3dkmtLuid(rawLuid);
    if (!luid) return null;
    const key = keyOf(luid);
    const sampleEpoch = epochOf(key);
    // The dedicated sys-stats lane already serializes calls. This per-LUID
    // guard also keeps an accidental concurrent overlay call from racing a
    // baseline, without allowing one physical adapter to borrow another's
    // in-flight result.
    const pending = inflight.get(key);
    if (pending) return pending;
    const current = (async () => {
      try {
        const adapter = queryStatistics({ type: D3DKMT_QUERYSTATISTICS_ADAPTER, luid });
        if (!adapter || adapter.status !== 0) {
          reset(key);
          return null;
        }
        const nodeCount = Number(adapter.nodeCount);
        if (!Number.isInteger(nodeCount) || nodeCount <= 0 || nodeCount > MAX_NODE_COUNT) {
          reset(key);
          return null;
        }
        const currentNodes = [];
        for (let id = 0; id < nodeCount; id++) {
          const node = queryStatistics({ type: D3DKMT_QUERYSTATISTICS_NODE, luid, nodeId: id });
          if (!node || node.status !== 0) {
            reset(key);
            return null;
          }
          currentNodes.push({
            id,
            globalRunningTime: node.globalRunningTime,
            systemRunningTime: node.systemRunningTime,
          });
        }
        const sampledAt = finiteNumber(now());
        if (sampledAt === null) {
          reset(key);
          return null;
        }
        // stop/reset may have happened while the native calls were in
        // flight. Do not let a completed old sample repopulate a baseline
        // that the next lane session should establish from scratch.
        if (sampleEpoch !== epochOf(key)) return null;
        const previous = states.get(key);
        states.set(key, { nodeCount, sampledAt, nodes: currentNodes });
        if (!previous || previous.nodeCount !== nodeCount) return null;
        return d3dkmtUtilPctOf(previous.nodes, currentNodes, sampledAt - previous.sampledAt);
      } catch {
        reset(key);
        return null;
      }
    })();
    inflight.set(key, current);
    return current.finally(() => {
      if (inflight.get(key) === current) inflight.delete(key);
    });
  };

  return {
    sample,
    reset,
    close() { reset(); },
  };
}
