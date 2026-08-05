// M1 — TelemetryService: poll cadence, power-from-energy derivation, ring
// buffer, subscription semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryService, IGCL_MIN_POLL_MS } from '../src/main/telemetry/telemetry-service.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';

test('constructor: poll cadence clamps to the 50 ms IGCL rate limit', () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0, { pollMs: 500 });
  assert.equal(t.pollMs, 500);
  const t2 = new TelemetryService(b, 0, { pollMs: 10 });
  assert.equal(t2.pollMs, IGCL_MIN_POLL_MS);
});

test('handleSample: derives powerW from energy deltas', () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0);
  const s0 = t.handleSample({ t: 1000, gpuEnergyJ: 395809.938172 });
  assert.equal(s0.powerW, undefined); // first sample has no delta
  const s1 = t.handleSample({ t: 1000.5, gpuEnergyJ: 395829.338172 }); // +19.4 J / 0.5 s
  assert.ok(Math.abs(s1.powerW - 38.8) < 1e-6);
});

test('handleSample: skips power when energy/timestamps are missing or non-increasing', () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0);
  t.handleSample({ t: 1000, gpuEnergyJ: 10 });
  // missing energy on second sample
  const s = t.handleSample({ t: 1000.5 });
  assert.equal(s.powerW, undefined);
  // energy counter wrap (decrease) -> no power
  const t2 = new TelemetryService(b, 0);
  t2.handleSample({ t: 1000, gpuEnergyJ: 10 });
  const s2 = t2.handleSample({ t: 1000.5, gpuEnergyJ: 2 });
  assert.equal(s2.powerW, undefined);
  // equal timestamps -> no power
  const t3 = new TelemetryService(b, 0);
  t3.handleSample({ t: 1000, gpuEnergyJ: 10 });
  const s3 = t3.handleSample({ t: 1000, gpuEnergyJ: 20 });
  assert.equal(s3.powerW, undefined);
});

test('ring buffer: caps at ringSize, oldest dropped', () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0, { ringSize: 3 });
  t.handleSample({ t: 1 });
  t.handleSample({ t: 2 });
  t.handleSample({ t: 3 });
  t.handleSample({ t: 4 });
  const ring = t.getRing();
  assert.equal(ring.length, 3);
  assert.deepEqual(ring.map((s) => s.t), [2, 3, 4]);
  assert.equal(t.latest().t, 4);
});

test('ring buffer: getRing returns a copy', () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0);
  t.handleSample({ t: 1 });
  const ring = t.getRing();
  ring.push({ t: 99 });
  assert.equal(t.getRing().length, 1);
});

test('onSample: subscribers get derived samples; unsubscribe works', () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0);
  const seen = [];
  const unsub = t.onSample((s) => seen.push(s));
  t.handleSample({ t: 1, gpuEnergyJ: 10 });
  t.handleSample({ t: 2, gpuEnergyJ: 20 });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].powerW, 10);
  unsub();
  t.handleSample({ t: 3, gpuEnergyJ: 30 });
  assert.equal(seen.length, 2);
});

test('start/stop: polls the mock backend at the configured cadence', async () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0, { pollMs: 60 });
  const seen = [];
  t.onSample((s) => seen.push(s));
  await t.start();
  assert.equal(t.running, true);
  await new Promise((r) => setTimeout(r, 260));
  await t.stop();
  assert.equal(t.running, false);
  assert.ok(seen.length >= 3, `expected >=3 samples, got ${seen.length}`);
  // derived powerW present from the mock ramp (19.4 J per 0.5 s nominal —
  // the mock's wall-clock spacing differs, so just check it is a number)
  assert.equal(typeof seen[seen.length - 1].powerW, 'number');
  // no samples arrive after stop
  const before = seen.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(seen.length, before);
});

test('start: single-flight — second start() is a no-op', async () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0, { pollMs: 100 });
  await t.start();
  await t.start();
  assert.equal(t.running, true);
  await t.stop();
});

test('start/stop: ring receives the polled samples', async () => {
  const b = new MockBackend();
  const t = new TelemetryService(b, 0, { pollMs: 40 });
  await t.start();
  await new Promise((r) => setTimeout(r, 200));
  await t.stop();
  assert.ok(t.getRing().length >= 3);
});
