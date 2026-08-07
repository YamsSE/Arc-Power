// M4-D2 — monitor-log tests: the CSV line format + the writer (header on
// first open, per-day files, RID_MOCK_LOG_DIR redirection, IO failures
// degrade to { ok: false } — never a throw).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MONITOR_LOG_HEADER, formatLogLine, createMonitorLog } from '../src/main/monitor-log.js';

test('M4-D2: the header row lists every logged field in order', () => {
  assert.equal(
    MONITOR_LOG_HEADER,
    'timestamp,gpuClockMhz,memClockMhz,tempC,powerW,utilPct,fanRpm,cpuUtilPct,cpuTempC,cpuFreqMhz,gpuMemUsedBytes,fps',
  );
});

test('M4-D2: formatLogLine renders the full sample as one CSV line', () => {
  const line = formatLogLine({
    t: 1234.5, gpuClockMhz: 2100, memClockMhz: 2187, tempC: 61, powerW: 145,
    utilPct: 42, fanRpm: [1200, 1300], cpuUtilPct: 42, cpuTempC: 61,
    cpuFreqMhz: 4300, gpuMemUsedBytes: 2971324416, fps: 60,
  });
  assert.equal(
    line,
    '1234.5,2100,2187,61,145,42,"1200;1300",42,61,4300,2971324416,60',
  );
});

test('M4-D2: formatLogLine handles nulls, arrays and embedded commas', () => {
  assert.equal(
    formatLogLine({ t: 1, gpuClockMhz: null, fanRpm: [1, 2], cpuTempC: undefined, fps: 0 }),
    '1,,,,,,"1;2",,,,,0',
  );
  assert.equal(formatLogLine({ t: 1, cpuUtilPct: '1,5' }), '1,,,,,,,"1,5",,,,', 'commas are quoted');
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rid-ap-monlog-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

test('M4-D2: the writer creates the per-day file with a header + the sample line', async (t) => {
  const dir = tempDir(t);
  const fixed = new Date(2026, 7, 7, 12, 0, 0); // 2026-08-07
  const log = createMonitorLog({ dir, now: () => fixed });
  const sample = { t: 1, gpuClockMhz: 2100, cpuUtilPct: 42, cpuTempC: 61, cpuFreqMhz: 4300, gpuMemUsedBytes: 2971324416, fps: 60 };
  const out = await log.append(sample);
  assert.equal(out.ok, true);
  const file = path.join(dir, 'monitor-20260807.csv');
  assert.equal(out.file, file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines[0], MONITOR_LOG_HEADER, 'the header is written on the first open');
  assert.equal(lines.length, 2, 'one data line');
  assert.equal(lines[1], formatLogLine(sample));
  // A second append adds a line WITHOUT re-writing the header.
  await log.append({ ...sample, t: 2 });
  const again = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(again.length, 3);
  assert.equal(again[0], MONITOR_LOG_HEADER);
  // A new day opens a NEW file (with its own header).
  const nextDay = createMonitorLog({ dir, now: () => new Date(2026, 7, 8, 0, 0, 0) });
  await nextDay.append(sample);
  const day2 = fs.readFileSync(path.join(dir, 'monitor-20260808.csv'), 'utf8').trim().split('\n');
  assert.equal(day2.length, 2);
});

test('M4-D2: an IO failure degrades to { ok: false, error } — never a throw', async () => {
  const log = createMonitorLog({
    dir: 'Z:\\definitely\\not\\writable\\' + Math.random(),
    now: () => new Date(),
  });
  const out = await log.append({ t: 1 });
  assert.equal(out.ok, false);
  assert.equal(typeof out.error, 'string');
});
