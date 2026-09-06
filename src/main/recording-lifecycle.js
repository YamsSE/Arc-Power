import path from 'node:path';

// Pure state helpers for the main-process Instant Replay save lifecycle.
// The capture protocol still calls this feature "replay"; this envelope is
// the user-facing state shared by every renderer and the desktop indicators.

export const INSTANT_REPLAY_SAVE_STATUS = Object.freeze({
  IDLE: 'idle',
  SAVING: 'saving',
  READY: 'ready',
  ERROR: 'error',
});

const VALID_STATUSES = new Set(Object.values(INSTANT_REPLAY_SAVE_STATUS));

export function createInstantReplaySaveState(status = INSTANT_REPLAY_SAVE_STATUS.IDLE, {
  error = null,
  outputPath = null,
  updatedAt = null,
} = {}) {
  const normalizedStatus = VALID_STATUSES.has(status) ? status : INSTANT_REPLAY_SAVE_STATUS.IDLE;
  const normalizedError = normalizedStatus === INSTANT_REPLAY_SAVE_STATUS.ERROR && typeof error === 'string' && error.trim()
    ? error.trim()
    : null;
  const normalizedOutputPath = normalizedStatus === INSTANT_REPLAY_SAVE_STATUS.READY && typeof outputPath === 'string' && outputPath.trim()
    ? outputPath.trim()
    : null;
  const normalizedUpdatedAt = Number.isFinite(updatedAt) ? Math.round(updatedAt) : null;
  return Object.freeze({
    status: normalizedStatus,
    error: normalizedError,
    outputPath: normalizedOutputPath,
    updatedAt: normalizedUpdatedAt,
  });
}

export function normalizeInstantReplaySaveState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return createInstantReplaySaveState(source.status, source);
}

export function instantReplaySaveStatusLabel(value) {
  const status = normalizeInstantReplaySaveState(value).status;
  if (status === INSTANT_REPLAY_SAVE_STATUS.SAVING) return 'Saving Instant Replay';
  if (status === INSTANT_REPLAY_SAVE_STATUS.READY) return 'Instant Replay ready';
  if (status === INSTANT_REPLAY_SAVE_STATUS.ERROR) return 'Instant Replay failed';
  return 'Instant Replay idle';
}

export function recordingSessionIdOf(state) {
  if (!state || typeof state !== 'object') return null;
  if (typeof state.sessionId === 'string' && state.sessionId.trim()) return state.sessionId.trim();
  return Number.isFinite(state.startedAt) ? `capture:${Math.round(state.startedAt)}` : null;
}

/**
 * Persist one authoritative replay-ready output and consume only the markers
 * that overlap its ready interval. The ready payload is deliberately passed
 * through unchanged so a missing interval remains visible to the caller.
 */
export async function persistReplayClipMetadata({ recordingStore, recordingRoot, outputPath, readyPayload } = {}) {
  if (!recordingStore?.recordClip || typeof recordingRoot !== 'string' || typeof outputPath !== 'string') return { clip: null, markerMapping: { mapped: false, reason: 'metadata-unavailable' } };
  const relativePath = path.relative(recordingRoot, outputPath);
  const clip = await recordingStore.recordClip({
    relativePath,
    fileName: path.basename(outputPath),
    apmSamples: readyPayload?.apmSamples,
    apmAverage: readyPayload?.apmAverage,
    apmPeak: readyPayload?.apmPeak,
  });
  const sourceSessionId = readyPayload?.sourceSessionId ?? readyPayload?.sessionId ?? null;
  const mapping = typeof recordingStore.attachMarkersToClip === 'function'
    ? await recordingStore.attachMarkersToClip({
      relativePath,
      sourceSessionId,
      sourceStartMs: readyPayload?.sourceStartMs,
      sourceEndMs: readyPayload?.sourceEndMs,
    })
    : null;
  return {
    clip: mapping?.clip ?? clip,
    markerMapping: mapping ?? { mapped: false, reason: 'marker-store-unavailable' },
  };
}

export function createRecordingLifecycleService({ recordingStore, recordingEngine, clock = () => Date.now() } = {}) {
  const activeReplay = (state) => state?.activeModes?.replay === true || (state?.running === true && state?.mode === 'replay');
  return {
    async autoStartInstantReplay() {
      if (!recordingStore?.settings || !recordingEngine?.startReplay) return { started: false, reason: 'unavailable', state: recordingEngine?.getState?.() ?? null };
      const settings = await recordingStore.settings();
      const before = recordingEngine.getState?.() ?? null;
      if (settings.instantReplayAutoStart !== true) return { started: false, reason: 'disabled', state: before };
      if (activeReplay(before)) return { started: false, reason: 'already-active', state: before };
      const state = await recordingEngine.startReplay({ ...settings });
      return { started: true, reason: null, state };
    },
    async addReplayMarker({ label = 'Marker', atMs = null } = {}) {
      if (!recordingStore?.addMarker || !recordingEngine?.getState) throw new Error('Recording markers are unavailable');
      const state = recordingEngine.getState();
      if (!activeReplay(state) && !(state?.activeModes?.video === true || (state?.running === true && state?.mode === 'video'))) {
        throw new Error('Start recording or Instant Replay before adding a marker');
      }
      const sessionId = recordingSessionIdOf(state);
      if (!sessionId) throw new Error('The active recording session has no stable identity');
      const elapsed = Number.isFinite(atMs) ? atMs : Math.max(0, clock() - Number(state.startedAt ?? clock()));
      return recordingStore.addMarker({ sessionId, atMs: elapsed, label });
    },
  };
}
