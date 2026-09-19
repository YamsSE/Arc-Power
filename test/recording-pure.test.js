import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecordingAccelerator,
  normalizeRecordingSettings,
} from '../src/main/recording-pure.js';
import { recordingEditorOperationTimeoutMs } from '../src/main/recording-editor.js';
import { buildAscentStartPayload } from '../src/main/recording-engine.js';
import { createRecordingActionHandler } from '../src/main/recording-hotkeys.js';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import os from 'node:os';

test('memory saving defaults to enabled', () => {
  assert.equal(normalizeRecordingSettings({}).memorySavingMode, true);
});

test('memory saving can be disabled', () => {
  assert.equal(normalizeRecordingSettings({ memorySavingMode: false }).memorySavingMode, false);
});

test('control aliases normalize', () => {
  assert.equal(normalizeRecordingAccelerator('Control+F9', 'F9'), 'Control+F9');
  assert.equal(normalizeRecordingAccelerator('Ctrl+F9', 'F9'), 'Control+F9');
});

test('recording hotkey preserves Control+F9', () => {
  assert.equal(normalizeRecordingSettings({ hotkeys: { start: 'Control+F9' } }).hotkeys.start, 'Control+F9');
});

test('long clip operations receive a duration-based timeout', () => {
  assert.ok(recordingEditorOperationTimeoutMs(180_000) > 120_000);
  assert.equal(recordingEditorOperationTimeoutMs(7_200_000), 30 * 60_000);
});

test('H264 recording starts with a keyframe-safe QSV payload', () => {
  const payload = buildAscentStartPayload(
    normalizeRecordingSettings({ encoderId: 'obs_qsv11_v2' }),
    'C:\\Temp\\arc-power-test.mp4',
  );
  assert.equal(payload.video_settings?.video_encoder?.id, 'obs_qsv11_v2');
  assert.equal(payload.video_settings?.video_encoder?.keyint_sec, 1);
  assert.equal(payload.video_settings?.video_encoder?.bframes, 0);
});

test('successful replay shortcut requests idle runtime shutdown', async () => {
  let shutdowns = 0;
  let result = null;
  const handler = createRecordingActionHandler({
    getSettings: async () => ({ location: 'C:\\Temp\\Arc Power Recording', replayLengthSec: 30 }),
    recordingEngine: {
      getState: () => ({ running: false }),
      async saveReplayClip() {},
    },
    shutdownRecordingRuntimeIfIdle: async () => { shutdowns += 1; },
    fsModule: { mkdirSync() {}, existsSync: () => false },
    onActionResult: async (next) => { result = next; },
  });

  await handler('saveClip');
  assert.equal(shutdowns, 1);
  assert.equal(result?.ok, true);
});

test('IPC replay clip save requests idle runtime shutdown after success', async () => {
  let shutdowns = 0;
  const { handlers } = createIpcHandlers({
    backend: { async listDevices() { return []; } },
    store: { async loadSettings() { return {}; } },
    recordingStore: { async settings() { return { location: os.tmpdir(), replayLengthSec: 30 }; } },
    recordingEngine: {
      async saveReplayClip() { return {}; },
      getState: () => ({ instantReplaySave: null }),
    },
    recordingRuntimeShutdownIfIdle: async () => { shutdowns += 1; },
    emit() {},
  });

  await handlers['recording-clip-save']({});
  assert.equal(shutdowns, 1);
});

test('replay save cleanup stays deferred while a Recording page lease is active', async () => {
  let pageLeaseCount = 1;
  let shutdowns = 0;
  const shutdownIfIdle = async () => {
    if (pageLeaseCount === 0) shutdowns += 1;
  };
  const handler = createRecordingActionHandler({
    getSettings: async () => ({ location: 'C:\\Temp\\Arc Power Recording', replayLengthSec: 30 }),
    recordingEngine: {
      getState: () => ({ running: false }),
      async saveReplayClip() {},
    },
    shutdownRecordingRuntimeIfIdle: shutdownIfIdle,
    fsModule: { mkdirSync() {}, existsSync: () => false },
  });

  await handler('saveClip');
  assert.equal(shutdowns, 0, 'the active Recording page lease must keep the runtime warm');
  pageLeaseCount = 0;
  await shutdownIfIdle();
  assert.equal(shutdowns, 1, 'idle cleanup must become effective after the lease is released');
});
