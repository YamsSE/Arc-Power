import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecordingAccelerator,
  normalizeRecordingSettings,
} from '../src/main/recording-pure.js';
import { recordingEditorOperationTimeoutMs } from '../src/main/recording-editor.js';
import { buildAscentStartPayload } from '../src/main/recording-engine.js';
import { createRecordingActionHandler, createRecordingHotkeys } from '../src/main/recording-hotkeys.js';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileStore } from '../src/main/store/profile-store.js';

test('memory saving defaults to disabled', () => {
  assert.equal(normalizeRecordingSettings({}).memorySavingMode, false);
});

test('memory saving can be explicitly enabled', () => {
  assert.equal(normalizeRecordingSettings({ memorySavingMode: true }).memorySavingMode, true);
});

test('memory saving can be disabled', () => {
  assert.equal(normalizeRecordingSettings({ memorySavingMode: false }).memorySavingMode, false);
});

test('recording status defaults memory saving off and preserves explicit true', async () => {
  const createHandlers = (getRecordingMemorySavingMode) => createIpcHandlers({
    backend: { async listDevices() { return []; } },
    store: { async loadSettings() { return {}; } },
    recordingEngine: { getState: () => ({ available: true, running: false }) },
    getRecordingMemorySavingMode,
    emit() {},
  }).handlers;

  assert.equal((await createHandlers()['recording-status']()).memorySavingMode, false);
  assert.equal((await createHandlers(() => true)['recording-status']()).memorySavingMode, true);
});

test('ProfileStore defaults memory saving off and preserves explicit choices', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-memory-saving-'));
  try {
    const store = new ProfileStore({ dir });
    assert.equal((await store.loadSettings()).memorySavingMode, false);

    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    assert.equal((await store.loadSettings()).memorySavingMode, false);

    await store.saveSettings({ memorySavingMode: true });
    await store.saveSettings({ theme: 'midnight' });
    assert.equal((await store.loadSettings()).memorySavingMode, true);

    await store.saveSettings({ memorySavingMode: false });
    assert.equal((await store.loadSettings()).memorySavingMode, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control aliases normalize', () => {
  assert.equal(normalizeRecordingAccelerator('Control+F9', 'F9'), 'Control+F9');
  assert.equal(normalizeRecordingAccelerator('Ctrl+F9', 'F9'), 'Control+F9');
});

test('recording hotkey preserves Control+F9', () => {
  assert.equal(normalizeRecordingSettings({ hotkeys: { start: 'Control+F9' } }).hotkeys.toggle, 'Control+F9');
});

test('recording hotkey migration prefers a customized legacy Start key', () => {
  assert.equal(normalizeRecordingSettings({ hotkeys: { start: 'Control+F9', stop: 'F10' } }).hotkeys.toggle, 'Control+F9');
});

test('recording hotkey migration uses customized legacy Stop only when Start is still default', () => {
  assert.equal(normalizeRecordingSettings({ hotkeys: { start: 'F9', stop: 'Control+F10' } }).hotkeys.toggle, 'Control+F10');
  assert.equal(normalizeRecordingSettings({ hotkeys: { start: 'F9', stop: 'F10' } }).hotkeys.toggle, 'F9');
});

test('explicit recording toggle hotkey, including blank, wins over legacy settings', () => {
  assert.equal(normalizeRecordingSettings({ hotkeys: { toggle: 'Control+F8', start: 'Control+F9', stop: 'Control+F10' } }).hotkeys.toggle, 'Control+F8');
  assert.equal(normalizeRecordingSettings({ hotkeys: { toggle: '', start: 'Control+F9', stop: 'Control+F10' } }).hotkeys.toggle, '');
});

test('recording hotkeys register a single toggle and preserve reserved-key collision handling', async () => {
  const registrations = [];
  const callbacks = new Map();
  const hotkeys = createRecordingHotkeys({
    shortcut: { register(accelerator, callback) { registrations.push(accelerator); callbacks.set(accelerator, callback); return true; }, unregister() {} },
    getSettings: async () => ({ hotkeys: { toggle: 'Control+F9', saveClip: 'F8', screenshot: 'F7' } }),
    onAction: (action) => assert.equal(action, 'toggle'),
    reserved: ['F8'],
  });
  const state = await hotkeys.register();
  assert.deepEqual(registrations, ['Control+F9', 'F7']);
  assert.equal(state.registered.toggle, 'Control+F9');
  assert.equal(state.registered.saveClip, undefined);
  assert.equal(state.conflicts.saveClip, 'F8');
  callbacks.get('Control+F9')();
});

test('blank recording toggle remains disabled', async () => {
  const registrations = [];
  const hotkeys = createRecordingHotkeys({
    shortcut: { register(accelerator) { registrations.push(accelerator); return true; }, unregister() {} },
    getSettings: async () => ({ hotkeys: { toggle: '', saveClip: '', screenshot: '' } }),
    onAction() {},
  });
  const state = await hotkeys.register();
  assert.deepEqual(registrations, []);
  assert.deepEqual(state.registered, {});
  assert.deepEqual(state.conflicts, {});
});

test('toggle starts video during replay-only capture without stopping replay', async () => {
  let state = { running: true, mode: 'replay', activeModes: { replay: true, video: false } };
  let starts = 0;
  let stops = 0;
  const handler = createRecordingActionHandler({
    getSettings: async () => ({ location: 'C:\\Temp\\Arc Power Recording' }),
    recordingEngine: {
      getState: () => state,
      async startRecording() { starts += 1; state = { running: true, mode: 'video', activeModes: { replay: true, video: true } }; },
      async stop() { stops += 1; },
    },
    fsModule: { mkdirSync() {}, existsSync: () => false },
  });
  await handler('toggle');
  assert.equal(starts, 1);
  assert.equal(stops, 0);
});

test('toggle stops video only while leaving replay active', async () => {
  let stoppedMode = null;
  let finalizedMode = null;
  const handler = createRecordingActionHandler({
    getSettings: async () => { throw new Error('stopping video must not require settings'); },
    recordingEngine: {
      getState: () => ({ running: true, mode: 'video', activeModes: { replay: true, video: true } }),
      async stop(mode) { stoppedMode = mode; },
    },
    onCaptureStopped: async (mode) => { finalizedMode = mode; },
  });
  await handler('toggle');
  assert.equal(stoppedMode, 'video');
  assert.equal(finalizedMode, 'video');
});

test('reentrant recording toggles are suppressed while async video start is pending', async () => {
  let releaseStart;
  let signalStartEntered;
  const startEntered = new Promise((resolve) => { signalStartEntered = resolve; });
  const pendingStart = new Promise((resolve) => { releaseStart = resolve; });
  let starts = 0;
  const handler = createRecordingActionHandler({
    getSettings: async () => ({ location: 'C:\\Temp\\Arc Power Recording' }),
    recordingEngine: {
      getState: () => ({ running: false, mode: null, activeModes: { replay: true, video: false } }),
      async startRecording() { starts += 1; signalStartEntered(); await pendingStart; },
    },
    fsModule: { mkdirSync() {}, existsSync: () => false },
  });
  const firstToggle = handler('toggle');
  await startEntered;
  await handler('toggle');
  assert.equal(starts, 1);
  releaseStart();
  await firstToggle;
  assert.equal(starts, 1);
});

test('reentrant recording toggles are suppressed while async video stop is pending', async () => {
  let releaseStop;
  let signalStopEntered;
  const stopEntered = new Promise((resolve) => { signalStopEntered = resolve; });
  const pendingStop = new Promise((resolve) => { releaseStop = resolve; });
  let stops = 0;
  let finalizations = 0;
  const handler = createRecordingActionHandler({
    getSettings: async () => { throw new Error('stopping video must not require settings'); },
    recordingEngine: {
      getState: () => ({ running: true, mode: 'video', activeModes: { replay: true, video: true } }),
      async stop(mode) { assert.equal(mode, 'video'); stops += 1; signalStopEntered(); await pendingStop; },
    },
    onCaptureStopped: async () => { finalizations += 1; },
  });
  const firstToggle = handler('toggle');
  await stopEntered;
  await handler('toggle');
  assert.equal(stops, 1);
  assert.equal(finalizations, 0);
  releaseStop();
  await firstToggle;
  assert.equal(finalizations, 1);
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

test('rate-control settings normalize legacy data and persist through RecordingStore', async () => {
  assert.deepEqual(
    (({ rateControl, maxBitrateKbps, rateControlQuality }) => ({ rateControl, maxBitrateKbps, rateControlQuality }))(normalizeRecordingSettings({})),
    { rateControl: 'CBR', maxBitrateKbps: 8000, rateControlQuality: 23 },
  );
  assert.equal(normalizeRecordingSettings({ rateControl: 'not-a-mode' }).rateControl, 'CBR');
  assert.equal(normalizeRecordingSettings({ bitrateKbps: 9000, maxBitrateKbps: 1000 }).maxBitrateKbps, 9000);
  assert.equal(normalizeRecordingSettings({ bitrateKbps: 700000, maxBitrateKbps: 1000 }).maxBitrateKbps, 700000);
  assert.equal(normalizeRecordingSettings({ bitrateKbps: 700000, maxBitrateKbps: 900000 }).maxBitrateKbps, 900000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-recording-rate-control-'));
  try {
    const store = new (await import('../src/main/store/recording-store.js')).RecordingStore({ dir });
    const saved = await store.saveSettings({ rateControl: 'VBR', bitrateKbps: 9000, maxBitrateKbps: 12000, rateControlQuality: 31 });
    const loaded = await store.settings();
    assert.equal(saved.rateControl, 'VBR');
    assert.equal(loaded.rateControl, 'VBR');
    assert.equal(loaded.bitrateKbps, 9000);
    assert.equal(loaded.maxBitrateKbps, 12000);
    assert.equal(loaded.rateControlQuality, 31);
    await store.saveSettings({ encoderId: 'obs_qsv11_av1', rateControl: 'CQP', rateControlQuality: 63 });
    assert.equal((await store.settings()).rateControlQuality, 63);
    await store.saveSettings({ encoderId: 'obs_qsv11_v2' });
    assert.equal((await store.settings()).rateControlQuality, 51, 'switching from AV1 CQP to H264 clamps the saved draft');
    await store.saveSettings({ rateControl: 'ICQ' });
    assert.equal((await store.settings()).rateControlQuality, 51, 'ICQ never preserves an AV1-only CQP value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QSV rate-control modes map to real encoder settings without CBR override', () => {
  const payloadFor = (rateControl) => buildAscentStartPayload(
    normalizeRecordingSettings({
      encoderId: 'obs_qsv11_v2', rateControl,
      bitrateKbps: 7000, maxBitrateKbps: 11000, rateControlQuality: 29,
    }),
    'C:\\Temp\\arc-power-test.mp4',
  ).video_settings.video_encoder;
  const cbr = payloadFor('CBR');
  assert.equal(cbr.rate_control, 'CBR');
  assert.equal(cbr.cbr, true);
  assert.equal(cbr.bitrate, 7000);
  assert.equal(cbr.max_bitrate, 7000);
  const vbr = payloadFor('VBR');
  assert.equal(vbr.rate_control, 'VBR');
  assert.equal(vbr.cbr, false);
  assert.equal(vbr.bitrate, 7000);
  assert.equal(vbr.max_bitrate, 11000);
  const cqp = payloadFor('CQP');
  assert.equal(cqp.rate_control, 'CQP');
  assert.equal(cqp.cbr, false);
  assert.equal(cqp.cqp, 29);
  assert.equal('bitrate' in cqp, false);
  const icq = payloadFor('ICQ');
  assert.equal(icq.rate_control, 'ICQ');
  assert.equal(icq.cbr, false);
  assert.equal(icq.icq_quality, 29);
  assert.equal('bitrate' in icq, false);
  const highTarget = buildAscentStartPayload(
    normalizeRecordingSettings({ encoderId: 'obs_qsv11_v2', rateControl: 'VBR', bitrateKbps: 700000, maxBitrateKbps: 1000 }),
    'C:\\Temp\\arc-power-test.mp4',
  ).video_settings.video_encoder;
  assert.equal(highTarget.bitrate, 700000);
  assert.equal(highTarget.max_bitrate, 700000, 'normalization raises max bitrate to the target without capping the target');
});

test('Recording rate-control IPC rejects invalid modes and out-of-range quality', async () => {
  const handlers = createIpcHandlers({ backend: { async listDevices() { return []; } }, emit() {} }).handlers;
  await assert.rejects(handlers['recording-settings-save']({ rateControl: 'VBR2' }), /invalid rate control/);
  await assert.rejects(handlers['recording-settings-save']({ rateControlQuality: 0 }), /quality must be an integer/);
  await assert.rejects(handlers['recording-settings-save']({ rateControlQuality: 64 }), /quality must be an integer/);
  await assert.rejects(handlers['recording-settings-save']({ rateControl: 'ICQ', rateControlQuality: 52 }), /ICQ quality must be an integer/);
  const highBitrateResult = await handlers['recording-settings-save']({ bitrateKbps: 700000, maxBitrateKbps: 900000 });
  assert.equal(highBitrateResult.settings.bitrateKbps, 700000);
  assert.equal(highBitrateResult.settings.maxBitrateKbps, 900000);
});

test('recording capture target IPC accepts bounded stable window identity fields', async () => {
  const handlers = createIpcHandlers({ backend: { async listDevices() { return []; } }, emit() {} }).handlers;
  const saved = await handlers['recording-settings-save']({ captureTarget: {
    type: 'window', windowHandle: 123, processName: 'game.exe',
    executablePath: 'C:\\Games\\game.exe', windowTitle: 'Game', windowClass: 'GameWindow',
  } });
  assert.equal(saved.settings.captureTarget.executablePath, 'C:\\Games\\game.exe');
  assert.equal(saved.settings.captureTarget.windowClass, 'GameWindow');
  await assert.rejects(handlers['recording-settings-save']({ captureTarget: { executablePath: 42 } }), /invalid executable path/);
  await assert.rejects(handlers['recording-settings-save']({ captureTarget: { executablePath: 'x'.repeat(4097) } }), /invalid executable path/);
  await assert.rejects(handlers['recording-settings-save']({ captureTarget: { windowClass: 42 } }), /invalid window class/);
  await assert.rejects(handlers['recording-settings-save']({ captureTarget: { windowClass: 'x'.repeat(257) } }), /invalid window class/);
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
