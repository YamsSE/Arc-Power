import test from 'node:test';
import assert from 'node:assert/strict';
import { vfCurveVoltageViewport } from '../src/renderer/pure/vf-curve-viewport.ts';
const range = { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300, maxPoints: 10 };
const stock = [{ voltageV: 0.6, freqMhz: 1800 }, { voltageV: 0.8, freqMhz: 2200 }];
const x = (point, domain) => (point.voltageV - domain.voltageMinV) / (domain.voltageMaxV - domain.voltageMinV);
test('common STOCK and LIVE origin shifts preserve pixels with actual native axis values', () => {
  const domain = vfCurveVoltageViewport(stock, stock, range, true);
  const shifted = stock.map(point => ({ ...point, voltageV: point.voltageV + 0.1 }));
  const next = vfCurveVoltageViewport(stock, shifted, range, true);
  assert.equal(next.voltageMinV, 0.5);
  assert.equal(next.voltageMaxV, 1.6);
  stock.forEach((point, index) => assert.ok(Math.abs(x(point, domain) - x(shifted[index], next)) < 1e-12));
  const edited = { ...shifted[0], voltageV: shifted[0].voltageV + 0.01 };
  assert.ok(x(edited, next) > x(shifted[0], next), 'Explicit voltage edits must move horizontally');
  assert.deepEqual(range, { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300, maxPoints: 10 });
});
test('missing, nonuniform and non-Battlemage STOCK never translate the viewport', () => {
  const expected = { voltageMinV: 0.4, voltageMaxV: 1.5 };
  assert.deepEqual(vfCurveVoltageViewport(stock, null, range, true), expected);
  assert.deepEqual(vfCurveVoltageViewport(stock, stock.map((point, index) => ({ ...point, voltageV: point.voltageV + index * 0.1 })), range, true), expected);
  assert.deepEqual(vfCurveVoltageViewport(stock, stock.map(point => ({ ...point, voltageV: point.voltageV + 0.1 })), range, false), expected);
});
