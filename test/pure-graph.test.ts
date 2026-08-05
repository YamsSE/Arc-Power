// M2b-B — rolling-graph series math: push/trim/scaling/downsampling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushSeries,
  trimSeriesWindow,
  autoScale,
  downsample,
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

test('pushSeries: immutable — the input array is not mutated', () => {
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
