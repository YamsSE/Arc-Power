import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('bundled screen-sharpening executable matches the production integrity pin', () => {
  const source = readFileSync(new URL('../src/main/sharpening-screen.js', import.meta.url), 'utf8');
  const pin = source.match(/const HELPER_SHA256 = '([A-F0-9]{64})';/)?.[1];
  assert.ok(pin, 'production helper integrity pin must be present');
  const executable = readFileSync(new URL('../src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe', import.meta.url));
  assert.equal(executable.subarray(0, 2).toString('ascii'), 'MZ');
  assert.equal(createHash('sha256').update(executable).digest('hex').toUpperCase(), pin,
    'a rebuilt helper must be repinned before it can be launched');
});
