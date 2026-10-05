import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecordingCaptureTarget } from '../src/main/recording-pure.js';
import { parseRecordingCaptureTargets, recordingCaptureSelection } from '../src/main/recording-capture.js';
import { createRecordingCaptureTargetsReader, recordingCaptureSelectionForStart } from '../src/main/recording-target-inventory.js';

const displayTargets = {
  displays: [{ id: '\\\\.\\DISPLAY1', label: 'Display 1', handle: 1, width: 1920, height: 1080, primary: true }],
  windows: [],
};

const window = (overrides = {}) => ({
  handle: 100,
  title: 'The Witcher 3',
  processName: 'witcher3.exe',
  executablePath: 'C:\\Games\\Witcher 3\\bin\\x64\\witcher3.exe',
  windowClass: 'GameWindow',
  width: 2560,
  height: 1440,
  ...overrides,
});

const savedTarget = (overrides = {}) => normalizeRecordingCaptureTarget({
  type: 'window',
  windowHandle: 100,
  processName: 'witcher3.exe',
  executablePath: 'c:/games/witcher 3/bin/x64/witcher3.exe',
  windowTitle: 'The Witcher 3',
  windowClass: 'GameWindow',
  ...overrides,
});

test('capture target normalization preserves stable window identity and accepts older targets', () => {
  assert.deepEqual(savedTarget(), {
    type: 'window', displayId: 'primary', windowHandle: 100,
    processName: 'witcher3.exe', executablePath: 'c:/games/witcher 3/bin/x64/witcher3.exe',
    windowTitle: 'The Witcher 3', windowClass: 'GameWindow',
  });
  assert.deepEqual(normalizeRecordingCaptureTarget({ type: 'window', windowHandle: 100, processName: 'witcher3.exe', windowTitle: 'The Witcher 3' }), {
    type: 'window', displayId: 'primary', windowHandle: 100,
    processName: 'witcher3.exe', executablePath: '', windowTitle: 'The Witcher 3', windowClass: '',
  });
});

test('capture inventory parses executable path and window class', () => {
  const parsed = parseRecordingCaptureTargets({
    displays: [],
    windows: [{ ...window(), titleBase64: Buffer.from('The Witcher 3').toString('base64'), title: undefined }],
  });
  assert.equal(parsed.windows[0].executablePath, window().executablePath);
  assert.equal(parsed.windows[0].windowClass, 'GameWindow');
  assert.equal(parsed.windows[0].title, 'The Witcher 3');
});

test('saved HWND remains preferred when it still identifies the saved executable', () => {
  const selected = recordingCaptureSelection(savedTarget(), { ...displayTargets, windows: [window({ title: 'Loading…' }), window({ handle: 101, title: 'The Witcher 3' })] });
  assert.equal(selected.captureSource.type, 'window');
  assert.equal(selected.captureSource.windowHandle, 100);
});

test('stale HWND rebinds across restart by case-insensitive executable path', () => {
  const selected = recordingCaptureSelection(savedTarget({ windowHandle: 999 }), { ...displayTargets, windows: [window({ handle: 200, title: 'New session' })] });
  assert.equal(selected.captureSource.type, 'window');
  assert.equal(selected.captureSource.windowHandle, 200);
  assert.equal(selected.captureTarget.windowHandle, 200);
  assert.equal(selected.captureTarget.executablePath, window().executablePath);
});

test('stale HWND can rebind by process name if Windows withholds the executable path', () => {
  const selected = recordingCaptureSelection(savedTarget({ windowHandle: 999 }), { ...displayTargets, windows: [
    window({ handle: 200, executablePath: '' }),
  ] });
  assert.equal(selected.captureSource.type, 'window');
  assert.equal(selected.captureSource.windowHandle, 200);
});

test('capture start refreshes a cached row before accepting its saved HWND', async () => {
  const stale = { ...displayTargets, windows: [window({ handle: 100 })] };
  const fresh = { ...displayTargets, windows: [window({ handle: 200 })] };
  const reader = createRecordingCaptureTargetsReader({ listTargets: async () => fresh });
  let refreshRequested = false;
  const readTargets = async (refresh) => {
    refreshRequested = refresh === true;
    return refreshRequested ? reader.read(true) : stale;
  };

  const selected = await recordingCaptureSelectionForStart(savedTarget(), readTargets, { size: { width: 1920, height: 1080 }, scaleFactor: 1 });
  assert.equal(refreshRequested, true);
  assert.equal(selected.captureSource.type, 'window');
  assert.equal(selected.captureSource.windowHandle, 200);
});

test('a forced inventory read runs after an older enumeration already in flight', async () => {
  let calls = 0;
  let finishOld;
  let finishFresh;
  const reader = createRecordingCaptureTargetsReader({
    listTargets: () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) finishOld = resolve;
      else finishFresh = resolve;
    }),
  });
  const warmup = reader.read();
  await Promise.resolve();
  const refresh = reader.read(true);
  assert.equal(calls, 1);
  finishOld({ windows: ['stale'] });
  await warmup;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  finishFresh({ windows: ['fresh'] });
  assert.deepEqual(await refresh, { windows: ['fresh'] });
  assert.deepEqual(reader.getCache(), { windows: ['fresh'] });
});

test('a reused HWND pointing to a different executable is rejected and stable identity is rebound', () => {
  const selected = recordingCaptureSelection(savedTarget(), { ...displayTargets, windows: [
    window({ processName: 'launcher.exe', executablePath: 'C:\\Games\\Launcher.exe' }),
    window({ handle: 201 }),
  ] });
  assert.equal(selected.captureSource.type, 'window');
  assert.equal(selected.captureSource.windowHandle, 201);
});

test('exact saved title disambiguates multiple windows from the same executable', () => {
  const selected = recordingCaptureSelection(savedTarget({ windowHandle: 999 }), { ...displayTargets, windows: [
    window({ handle: 201, title: 'Launcher' }),
    window({ handle: 202, title: 'The Witcher 3' }),
  ] });
  assert.equal(selected.captureSource.type, 'window');
  assert.equal(selected.captureSource.windowHandle, 202);
});

test('ambiguous same-executable windows do not silently select one', () => {
  const selected = recordingCaptureSelection(savedTarget({ windowHandle: 999 }), { ...displayTargets, windows: [
    window({ handle: 201, title: 'Different title A' }),
    window({ handle: 202, title: 'Different title B' }),
  ] });
  assert.equal(selected.captureSource.type, 'display');
  assert.equal(selected.captureSource.monitorHandle, 1);
});

test('older title/process targets rebind when unambiguous and preserve display selection behavior', () => {
  const legacy = normalizeRecordingCaptureTarget({ type: 'window', windowHandle: 999, processName: 'witcher3.exe', windowTitle: 'The Witcher 3' });
  const rebound = recordingCaptureSelection(legacy, { ...displayTargets, windows: [window({ handle: 200 })] });
  assert.equal(rebound.captureSource.type, 'window');
  assert.equal(rebound.captureSource.windowHandle, 200);

  const display = recordingCaptureSelection({ type: 'display', displayId: '\\\\.\\DISPLAY1' }, displayTargets);
  assert.equal(display.captureSource.type, 'display');
  assert.equal(display.captureSource.monitorHandle, 1);
});
