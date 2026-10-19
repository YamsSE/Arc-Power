import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFanResumeStore } from '../src/main/store/fan-resume-store.js';

test('FanResume sidecar validates, reloads by physical key, and preserves unrelated GPU rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-resume-'));
  try {
    const store = createFanResumeStore({ dir });
    await store.set({ deviceKey: 'gpu:a', physicalTarget: { bdf: '00:02.0' }, settings: { fanMode: 'auto' } });
    await store.set({ deviceKey: 'gpu:b', physicalTarget: { bdf: '00:03.0' }, settings: { fanMode: 'fixed', fixedFanPct: 42 } });
    const reloaded = createFanResumeStore({ dir });
    assert.deepEqual((await reloaded.get('gpu:a')).settings, { fanMode: 'auto' });
    assert.equal((await reloaded.list()).length, 2);
    await assert.rejects(reloaded.set({ deviceKey: 'gpu:c', physicalTarget: { bdf: '00:04.0' }, settings: {
      fanMode: 'curve', fanCurve: [{ t: -1, speedPct: 20 }, { t: 40, speedPct: 80 }],
    } }));
    await assert.rejects(reloaded.set({ deviceKey: 'gpu:c', physicalTarget: {}, settings: { gpuLock: {} } }));
    await reloaded.remove('gpu:a');
    assert.equal((await reloaded.list())[0].deviceKey, 'gpu:b');
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'FanResume.json'), 'utf8'));
    assert.equal(data.schemaVersion, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
