import fs from 'node:fs';
import path from 'node:path';
import { collisionSafeRecordingPath, normalizeRecordingAccelerator, recordingAbsolutePath } from './recording-pure.js';

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
    const actions = [['start', 'start'], ['stop', 'stop'], ['saveClip', 'saveClip']];
    for (const [key, action] of actions) {
      const accelerator = normalizeRecordingAccelerator(settings.hotkeys?.[key], key === 'start' ? 'F9' : key === 'stop' ? 'F10' : 'F8');
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

export function createRecordingActionHandler({ getSettings, recordingEngine, fsModule = fs, pathModule = path, now = () => new Date(), log = (message) => console.log(message), onActionResult = async () => {} } = {}) {
  return async (action) => {
    let error = null;
    let preActionMode = null;
    let didStop = false;
    try {
      // Stop must remain available even when a persisted capture location is
      // malformed, unavailable, or unwritable. It has no output-directory
      // dependency, so dispatch it before reading settings or touching fs.
      if (action === 'stop') {
        const before = recordingEngine.getState?.() ?? null;
        preActionMode = before?.mode ?? null;
        didStop = before?.running === true;
        await recordingEngine.stop();
        return;
      }
      const settings = await getSettings();
      const location = recordingAbsolutePath(settings.location, 'location');
      fsModule.mkdirSync(location, { recursive: true });
      if (action === 'start') {
        const outputPath = collisionSafeRecordingPath(location, 'recording', { exists: (candidate) => fsModule.existsSync?.(candidate) === true });
        await recordingEngine.startRecording({ ...settings, outputPath });
      } else if (action === 'saveClip') {
        const outputPath = collisionSafeRecordingPath(location, 'clip', { exists: (candidate) => fsModule.existsSync?.(candidate) === true });
        await recordingEngine.saveReplayClip({ path: outputPath, headDuration: settings.replayLengthSec * 1000, thumbnailFolder: location });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log(`[recording] shortcut ${action} failed: ${error}`);
    } finally {
      try {
        await onActionResult({ action, ok: error === null, error, preActionMode, ...(action === 'stop' ? { didStop } : {}), state: recordingEngine.getState?.() ?? null });
      } catch {
        // Notification delivery must never affect the hotkey action itself.
      }
    }
  };
}
