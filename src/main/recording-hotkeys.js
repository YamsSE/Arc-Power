import fs from 'node:fs';
import path from 'node:path';
import { collisionSafeRecordingPath, normalizeRecordingAccelerator, recordingAbsolutePath } from './recording-pure.js';
import { collisionSafeRecordingScreenshotPath } from './recording-screenshot.js';

export { normalizeRecordingAccelerator };

export function createRecordingHotkeys({ shortcut, getSettings, onAction, reserved = [] } = {}) {
  let registered = new Map();
  let state = { registered: {}, conflicts: {}, error: null };
  const reservedSet = () => new Set((typeof reserved === 'function' ? reserved() : reserved).filter(Boolean)
    .map((item) => normalizeRecordingAccelerator(item, String(item))));
  const unregister = () => {
    for (const accelerator of registered.keys()) { try { shortcut?.unregister?.(accelerator); } catch {} }
    registered = new Map();
  };
  const register = async () => {
    unregister();
    const settings = await getSettings();
    const reservedAccelerators = reservedSet();
    const next = { registered: {}, conflicts: {}, error: null };
    const actions = [['start', 'start'], ['stop', 'stop'], ['saveClip', 'saveClip'], ['screenshot', 'screenshot']];
    if (settings.hotkeys && Object.prototype.hasOwnProperty.call(settings.hotkeys, 'marker')) actions.splice(3, 0, ['marker', 'marker']);
    for (const [key, action] of actions) {
      const accelerator = normalizeRecordingAccelerator(settings.hotkeys?.[key], key === 'start' ? 'F9' : key === 'stop' ? 'F10' : key === 'saveClip' ? 'F8' : key === 'marker' ? 'F6' : 'F7');
      if (reservedAccelerators.has(accelerator) || Object.values(next.registered).includes(accelerator)) {
        next.conflicts[key] = accelerator;
        continue;
      }
      let ok = false;
      try { ok = shortcut?.register?.(accelerator, () => { void onAction(action); }) === true; } catch (err) { next.error = err.message; }
      if (ok) { registered.set(accelerator, action); next.registered[key] = accelerator; }
      else {
        next.conflicts[key] = accelerator;
        if (!next.error) next.error = `Could not register ${accelerator}`;
      }
    }
    state = next;
    return { ...state, registered: { ...state.registered }, conflicts: { ...state.conflicts } };
  };
  return { register, unregister, getState: () => ({ ...state, registered: { ...state.registered }, conflicts: { ...state.conflicts } }) };
}

export function createRecordingActionHandler({ getSettings, recordingEngine, captureScreenshot = null, addMarker = null, saveReplayClip = null, fsModule = fs, pathModule = path, now = () => new Date(), log = (message) => console.log(message), onActionResult = async () => {} } = {}) {
  return async (action) => {
    let error = null;
    let preActionMode = null;
    let didStop = false;
    let outputPath = null;
    try {
      // Stop must remain available even when a persisted capture location is
      // malformed, unavailable, or unwritable. It has no output-directory
      // dependency, so dispatch it before reading settings or touching fs.
      if (action === 'stop') {
        const before = recordingEngine.getState?.() ?? null;
        preActionMode = before?.mode ?? null;
        didStop = before?.running === true;
        const activeModes = before?.activeModes;
        const stopMode = activeModes?.video === true || before?.mode === 'video'
          ? 'video'
          : activeModes?.replay === true || before?.mode === 'replay' ? 'replay' : null;
        await recordingEngine.stop(stopMode);
        return;
      }
      if (action === 'marker') {
        if (typeof addMarker !== 'function') throw new Error('Recording markers are unavailable');
        await addMarker({});
        return;
      }
      const settings = await getSettings();
      const location = recordingAbsolutePath(settings.location, 'location');
      fsModule.mkdirSync(location, { recursive: true });
      if (action === 'screenshot') {
        if (typeof captureScreenshot !== 'function') throw new Error('Screenshot capture is unavailable');
        outputPath = collisionSafeRecordingScreenshotPath(location, { exists: (candidate) => fsModule.existsSync?.(candidate) === true });
        await captureScreenshot({ target: settings.captureTarget, outputPath });
        return;
      }
      if (action === 'start') {
        outputPath = collisionSafeRecordingPath(location, 'recording', { exists: (candidate) => fsModule.existsSync?.(candidate) === true });
        await recordingEngine.startRecording({ ...settings, outputPath });
      } else if (action === 'saveClip') {
        outputPath = collisionSafeRecordingPath(location, 'clip', { exists: (candidate) => fsModule.existsSync?.(candidate) === true });
        const save = typeof saveReplayClip === 'function' ? saveReplayClip : recordingEngine.saveReplayClip.bind(recordingEngine);
        await save({ path: outputPath, headDuration: settings.replayLengthSec * 1000, thumbnailFolder: location });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log(`[recording] shortcut ${action} failed: ${error}`);
    } finally {
      try {
        const state = recordingEngine.getState?.() ?? null;
        await onActionResult({ action, ok: error === null, error, preActionMode, ...(action === 'stop' ? { didStop } : {}), ...(outputPath ? { outputPath: pathModule.basename(outputPath) } : {}), state, ...(state?.instantReplaySave ? { instantReplaySave: state.instantReplaySave } : {}) });
      } catch {
        // Notification delivery must never affect the hotkey action itself.
      }
    }
  };
}
