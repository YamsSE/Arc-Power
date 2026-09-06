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
