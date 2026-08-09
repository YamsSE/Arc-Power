// Arc Power - M7a the FPS percentile math (pure, DOM-free; unit-tested in
// test/fps-percentiles.test.js with hand-computed fixtures).
//
// The 1% Low / 99% FPS definitions (the CapFrameX conventions, pinned by
// the tests):
//   - the ring holds ONE entry per 200 ms sampler tick - { tMs, ftMs,
//     frames } (ftMs = the tick's mean frame time, frames = the frames the
//     tick counted);
//   - p99 ("99% FPS"): expand each entry into `frames` copies of its ftMs
//     (the frame-count-weighted form), sort ascending, take the 1-based
//     index i = max(1, ceil(0.99 * N)) - the boundary of the worst 1% -
//     and 99% FPS = 1000 / ft[i];
//   - low1 ("1% Low"): the average FPS of the slowest 1% of frames - the
//     tail starting at the SAME index i: 1% Low = 1000 / (mean ft of
//     frames[i..N]). 1% Low <= 99% FPS always (the tail mean >= the
//     boundary).
//   - whole-number output (Math.round); honest null when the ring holds
//     fewer than 60 frames total in the recency window (the 60-frame floor
//     keeps the first seconds honest instead of showing garbage from 2
//     samples).
//
// AGE EVICTION (plan-review F1): every computation is scoped to a recency
// window - entries older than windowMs are dropped FIRST. A static desktop
// pushes nothing, so after the window elapses the ring is empty and the
// percentiles honestly return null (NOT stale last-known values).

/** The ring's max depth: ~150 entries at the 200 ms sampler cadence is the
 *  ~30 s rolling window (fps-dxgi.js pushes through pushRing with this). */
export const RING_MAX = 150;

/** The percentile recency window (ms) - the ring's age-eviction horizon. */
export const PERCENTILE_WINDOW_MS = 30000;

/** The 60-frame floor: the percentiles need at least this many frames in
 *  the window or they honestly report null (the first seconds after a poll
 *  never show garbage from a couple of samples). */
export const MIN_FRAMES_FOR_PERCENTILES = 60;

/** The p99 boundary fraction: i = max(1, ceil(0.99 * N)). */
export const P99_BOUNDARY = 0.99;

/** The per-entry expansion clamp: one tick may contribute at most this
 *  many frame copies to the weighted ft list. 10,000 frames in one 200 ms
 *  tick = 50,000 fps - far beyond any real display, so an honest stream
 *  never touches it; a garbage counter delta is bounded to a ~80 KB build
 *  instead of a multi-GB array inside poll(). */
export const MAX_FRAMES_PER_ENTRY = 10000;

/**
 * Push one ring entry, dropping the oldest when the ring exceeds max
 * (mutates and returns the ring - the sampler's capacity discipline).
 * Ring entries: { tMs, ftMs, frames }.
 * @param {Array<{ tMs: number, ftMs: number, frames: number }>} ring
 * @param {{ tMs: number, ftMs: number, frames: number }} entry
 * @param {number} [max] the ring's max depth (default RING_MAX)
 * @returns {Array<{ tMs: number, ftMs: number, frames: number }>}
 */
export function pushRing(ring, entry, max = RING_MAX) {
  ring.push(entry);
  if (ring.length > max) ring.splice(0, ring.length - max);
  return ring;
}

/**
 * The frames presented within [nowMs - windowMs, nowMs] - the rolling fps
 * numerator (the sampler's poll computes fps = frames per second from
 * this; an empty window honestly sums to 0 - the static-desktop shape,
 * never '-'). Entry times at exactly the window edge are included.
 * @param {Array<{ tMs: number, ftMs: number, frames: number }>} ring
 * @param {number} nowMs
 * @param {number} windowMs
 * @returns {number}
 */
export function rollingFps(ring, nowMs, windowMs) {
  let frames = 0;
  for (const e of ring) {
    if (e.tMs >= nowMs - windowMs) frames += e.frames;
  }
  return frames;
}

/**
 * The 1% Low / 99% FPS stats over the recency window - { low1Pct, p99 } or
 * null (the 60-frame floor / an empty ring after age eviction - the honest
 * degrade). Age eviction happens FIRST: entries older than windowMs never
 * contribute.
 * @param {Array<{ tMs: number, ftMs: number, frames: number }>} ring
 * @param {number} nowMs
 * @param {number} windowMs
 * @returns {{ low1Pct: number, p99: number } | null}
 */
export function percentileStats(ring, nowMs, windowMs) {
  // Age eviction first: the computation is scoped to the recency window.
  const fresh = [];
  let totalFrames = 0;
  for (const e of ring) {
    if (e.tMs < nowMs - windowMs) continue;
    fresh.push(e);
    totalFrames += e.frames;
  }
  // The 60-frame floor: fewer frames than this is noise, not a percentile.
  if (totalFrames < MIN_FRAMES_FOR_PERCENTILES) return null;
  // Expand into the frame-count-weighted ft list (each entry contributes
  // `frames` copies of its mean frame time), sorted ascending.
  const ft = [];
  for (const e of fresh) {
    // COUNTER-RESET EDGE: `frames` is a raw uint32 delta from the DXGI
    // PresentCount (wrappedDelta / duplication AccumulatedFrames). A
    // PresentCount RESET without the DISCONTINUOUS flag violates the DXGI
    // contract (DISCONTINUOUS is the documented reset signal) and yields a
    // delta near 2^32 - an unbounded expansion here would allocate a
    // multi-GB array inside poll(). The clamp (MAX_FRAMES_PER_ENTRY) caps
    // the blast radius: the garbage tick contributes 10,000 copies at most.
    // The 60-frame floor above still sees the RAW sum, so the percentiles
    // degrade honestly - a garbage tick can inflate the frame count, never
    // the allocation.
    const n = Math.min(Math.max(1, e.frames), MAX_FRAMES_PER_ENTRY);
    for (let i = 0; i < n; i++) ft.push(e.ftMs);
  }
  ft.sort((a, b) => a - b);
  const n = ft.length;
  // The 1-based index of the worst-1% boundary - the SAME index feeds both
  // stats: i = max(1, ceil(0.99 * N)).
  const i = Math.max(1, Math.ceil(P99_BOUNDARY * n));
  // 99% FPS = 1000 / ft[i] (the boundary of the slowest 1% of frames).
  const p99 = Math.round(1000 / ft[i - 1]);
  // 1% Low = 1000 / (mean ft of the tail frames[i..N]).
  let tailSum = 0;
  for (let j = i - 1; j < n; j++) tailSum += ft[j];
  const low1Pct = Math.round(1000 / (tailSum / (n - i + 1)));
  return { low1Pct, p99 };
}
