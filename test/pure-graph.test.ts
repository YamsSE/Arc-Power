// M2b-B â€” rolling-graph series math: push/trim/scaling/downsampling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushSeries,
  trimSeriesWindow,
  sortSeriesByTime,
  autoScale,
  downsample,
  nearestSampleIndex,
  GRAPH_WINDOW_S,
  GRAPH_MAX_POINTS,
} from '../src/renderer/pure/graph.ts';
import type { SeriesPoint } from '../src/renderer/pure/graph.ts';

test('pushSeries: appends a sample and caps the series length', () => {
  let s: SeriesPoint[] = [];
  for (let i = 0; i < 250; i++) s = pushSeries(s, i, i * 10, 240);
  assert.equal(s.length, 240);
  assert.equal(s[0].t, 10);
  assert.equal(s[239].t, 249);
});

test('pushSeries: absent/non-finite values are dropped (gap, not zero)', () => {
  const s = pushSeries(pushSeries([], 0, 100), 1, undefined);
  assert.equal(s.length, 1);
  assert.equal(s[0].v, 100);
});

test('pushSeries: immutable â€” the input array is not mutated', () => {
  const before: SeriesPoint[] = [{ t: 0, v: 1 }];
  const after = pushSeries(before, 1, 2, 10);
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});

test('trimSeriesWindow: drops points older than the window', () => {
  const s = [{ t: 0, v: 1 }, { t: 30, v: 2 }, { t: 59, v: 3 }, { t: 61, v: 4 }];
  const trimmed = trimSeriesWindow(s, 62, 60);
  assert.deepEqual(trimmed.map((p) => p.t), [30, 59, 61]);
});

test('trimSeriesWindow: everything inside the window passes through', () => {
  const s = [{ t: 2, v: 1 }, { t: 3, v: 2 }];
  const trimmed = trimSeriesWindow(s, 62, GRAPH_WINDOW_S);
  assert.equal(trimmed, s);
});

test('trimSeriesWindow: an empty series stays empty', () => {
  assert.deepEqual(trimSeriesWindow([], 10), []);
});

test('autoScale: pads min/max with 10% headroom', () => {
  const { min, max } = autoScale([{ t: 0, v: 10 }, { t: 1, v: 20 }]) as { min: number; max: number };
  assert.ok(Math.abs(min - 9) < 1e-9);
  assert.ok(Math.abs(max - 21) < 1e-9);
});

test('autoScale: a flat series gets a symmetric pad (never a zero-height scale)', () => {
  const { min, max } = autoScale([{ t: 0, v: 0 }, { t: 1, v: 0 }]) as { min: number; max: number };
  assert.equal(min, -1);
  assert.equal(max, 1);
  const flat = autoScale([{ t: 0, v: 100 }, { t: 1, v: 100 }]) as { min: number; max: number };
  assert.ok(flat.min < 100 && flat.max > 100);
});

test('autoScale: empty series return null (canvas draws empty)', () => {
  assert.equal(autoScale([]), null);
});

test('downsample: shorter series pass through untouched', () => {
  const s = [{ t: 0, v: 1 }, { t: 1, v: 2 }];
  assert.equal(downsample(s, 100), s);
});

test('downsample: long series pick evenly-spaced buckets, endpoints kept', () => {
  const s = Array.from({ length: 100 }, (_, i) => ({ t: i, v: i }));
  const out = downsample(s, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0].t, 0);
  assert.equal(out[9].t, 99);
  assert.equal(out[4].t, 44); // round(4 * 99/9)
});

test('downsample: a cap below 2 keeps the first point only', () => {
  const s = Array.from({ length: 10 }, (_, i) => ({ t: i, v: i }));
  assert.equal(downsample(s, 1).length, 1);
  assert.equal(downsample(s, 0).length, 0);
});

test('downsample: the default max is the module constant (240)', () => {
  const s = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i }));
  assert.equal(downsample(s, GRAPH_MAX_POINTS).length, GRAPH_MAX_POINTS);
});

// M4-C â€” the nearest-sample lookup behind the Monitoring hover popup.

test('nearestSampleIndex: an empty series returns -1 (no crosshair/popup)', () => {
  assert.equal(nearestSampleIndex([], 0.5), -1);
});

test('nearestSampleIndex: clamps to the edge samples outside the plot', () => {
  const s = [{ t: 10, v: 1 }, { t: 20, v: 2 }, { t: 30, v: 3 }];
  assert.equal(nearestSampleIndex(s, -0.5), 0);
  assert.equal(nearestSampleIndex(s, 1.5), 2);
  assert.equal(nearestSampleIndex(s, 0), 0);
  assert.equal(nearestSampleIndex(s, 1), 2);
});

test('nearestSampleIndex: exact hits return the exact index', () => {
  const s = [{ t: 0, v: 1 }, { t: 30, v: 2 }, { t: 60, v: 3 }];
  assert.equal(nearestSampleIndex(s, 0), 0);
  assert.equal(nearestSampleIndex(s, 0.5), 1); // target 30
  assert.equal(nearestSampleIndex(s, 1), 2);
});

test('nearestSampleIndex: between-sample positions round to the closest by time', () => {
  const s = [{ t: 0, v: 1 }, { t: 10, v: 2 }, { t: 20, v: 3 }];
  // xNorm 0.6 -> target 12 -> 10 (dist 2) beats 20 (dist 8).
  assert.equal(nearestSampleIndex(s, 0.6), 1);
  // xNorm 0.9 -> target 18 -> 20 (dist 2) beats 10 (dist 8).
  assert.equal(nearestSampleIndex(s, 0.9), 2);
});

test('nearestSampleIndex: uneven time spacing picks the closest by time, ties keep the earlier sample', () => {
  // t span 0..50: xNorm 0.5 -> target 25 -> 5 (dist 20) beats 50 (dist 25).
  const uneven = [{ t: 0, v: 1 }, { t: 5, v: 2 }, { t: 50, v: 3 }];
  assert.equal(nearestSampleIndex(uneven, 0.5), 1);
  // Exact tie (target 15, samples 10 and 20): the earlier sample wins.
  const tie = [{ t: 0, v: 1 }, { t: 10, v: 2 }, { t: 20, v: 3 }];
  assert.equal(nearestSampleIndex(tie, 0.75), 1);
});

test('M4-D2 fix: sortSeriesByTime — the real driver t ticks BACKWARD sometimes (8 folds in 40 s live); the sorted series never folds the polyline', () => {
  // the live-shaped sequence: mostly forward 0.5 s ticks + two backward ticks
  const raw = [
    { t: 100.0, v: 10 },
    { t: 100.5, v: 12 },
    { t: 100.1, v: 11 }, // backward tick (driver counter race)
    { t: 101.0, v: 14 },
    { t: 101.5, v: 13 },
    { t: 101.2, v: 15 }, // backward tick
    { t: 102.0, v: 16 },
  ];
  const sorted = sortSeriesByTime(raw);
  assert.deepEqual(sorted.map((p) => p.t), [100.0, 100.1, 100.5, 101.0, 101.2, 101.5, 102.0]);
  assert.deepEqual(sorted.map((p) => p.v), [10, 11, 12, 14, 15, 13, 16]);
  // monotonic: no delta < 0 (the drawing x can never fold)
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].t - sorted[i - 1].t >= 0);
});

test('M4-D2 fix: sortSeriesByTime — immutability + trivial cases', () => {
  const one = [{ t: 5, v: 1 }];
  assert.equal(sortSeriesByTime(one), one);
  assert.deepEqual(sortSeriesByTime([]), []);
  const src = [{ t: 2, v: 2 }, { t: 1, v: 1 }];
  const out = sortSeriesByTime(src);
  assert.notEqual(out, src);
  assert.deepEqual(src, [{ t: 2, v: 2 }, { t: 1, v: 1 }]);
});

test('M4-D2 fix: pushSeries + sortSeriesByTime + trimSeriesWindow compose — the drawn window stays 60 s of driver time even with backward ticks', () => {
  let series = [] as SeriesPoint[];
  const push = (t: number, v: number) => {
    series = trimSeriesWindow(sortSeriesByTime(pushSeries(series, t, v)), t, GRAPH_WINDOW_S);
  };
  push(100.0, 1);
  push(100.5, 2);
  push(100.2, 3); // backward tick
  push(160.0, 4); // beyond the window
  assert.deepEqual(series.map((p) => p.t), [100.0, 100.2, 100.5, 160.0]);
  for (let i = 1; i < series.length; i++) assert.ok(series[i].t >= series[i - 1].t);
});
