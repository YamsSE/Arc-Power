import test from 'node:test';
import assert from 'node:assert/strict';
import { provenVfRequest, matchesProvenVfRequest } from '../src/main/backend/vf-proven-request.js';

test('proven VF identity retains request and effective displacement from STOCK', () => {
  const stock = [{ Voltage: 700, Frequency: 1000 }, { Voltage: 800, Frequency: 3210 }];
  const request = stock.map((p, i) => ({ ...p, Frequency: i ? 3230 : p.Frequency }));
  const live = stock.map((p, i) => ({ ...p, Frequency: i ? 3220 : p.Frequency }));
  const evidence = provenVfRequest(request, stock, live);
  const shift = (points) => points.map((p) => ({ ...p, Voltage: p.Voltage + 10 }));
  assert.equal(matchesProvenVfRequest(evidence, shift(request), shift(stock), shift(live)), true);
  assert.equal(matchesProvenVfRequest(evidence, shift(request), stock, live), false);
  assert.equal(matchesProvenVfRequest(evidence, request, stock, shift(live)), false);
  const changedStock = stock.map((p, i) => ({ ...p, Frequency: i ? 3200 : p.Frequency }));
  assert.equal(matchesProvenVfRequest(evidence, request, changedStock, live), false);
  assert.equal(matchesProvenVfRequest(null, request, stock, live), false);
});
