import test from 'node:test';
import assert from 'node:assert/strict';
import { vfCurveVoltageViewport } from '../src/renderer/pure/vf-curve-viewport.ts';
const range = { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300, maxPoints: 10 };
const live = [{ voltageV: 0.6, freqMhz: 1800 }, { voltageV: 0.8, freqMhz: 2200 }];
const x = (point, domain) => (point.voltageV - domain.voltageMinV) / (domain.voltageMaxV - domain.voltageMinV);
test('LIVE-only origin shift plus frequency edits preserves horizontal pixels and actual axis values', () => {
  const domain = vfCurveVoltageViewport(live, live, range, true);
  const shifted = live.map(point => ({ voltageV: point.voltageV + 0.1, freqMhz: point.freqMhz + 20 }));
  const next = vfCurveVoltageViewport(live, shifted, range, true);
  assert.ok(Math.abs(next.voltageMinV - 0.5) < 1e-12);
  assert.ok(Math.abs(next.voltageMaxV - 1.6) < 1e-12);
  live.forEach((point, index) => assert.ok(Math.abs(x(point, domain) - x(shifted[index], next)) < 1e-12));
  const edited = { ...shifted[1], voltageV: shifted[1].voltageV + 0.01 };
  assert.ok(Math.abs(x(edited, next) - x(shifted[1], next) - 0.01 / 1.1) < 1e-12, 'Draft voltage edit moves on frozen accepted domain');
});
test('STOCK-only change cannot affect LIVE viewport; per-point changes retain shape', () => {
  const domain = vfCurveVoltageViewport(live, live, range, true);
  const independentStock = live.map(point => ({ ...point, voltageV: point.voltageV + 0.1 }));
  assert.notDeepEqual(independentStock, live);
  assert.deepEqual(vfCurveVoltageViewport(live, live, range, true), domain);
  const nextLive = live.map((point, index) => ({ ...point, voltageV: point.voltageV + (index ? 0.12 : 0.1) }));
  const next = vfCurveVoltageViewport(live, nextLive, range, true);
  assert.ok(Math.abs(x(nextLive[1], next) - x(live[1], domain) - 0.02 / 1.1) < 1e-12);
});
test('missing and non-Battlemage LIVE keep the native range', () => {
  const expected = { voltageMinV: 0.4, voltageMaxV: 1.5 };
  assert.deepEqual(vfCurveVoltageViewport(live, null, range, true), expected);
  assert.deepEqual(vfCurveVoltageViewport(live, live.map(point => ({ ...point, voltageV: point.voltageV + 0.1 })), range, false), expected);
});
