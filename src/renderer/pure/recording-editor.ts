// Pure bounds and naming helpers shared by the recording editor UI and tests.

export type RecordingEditorRange = {
  startMs: number;
  endMs: number;
  durationMs: number;
};

export function normalizeRecordingEditorClipName(value: string, fallback = 'Arc Edit'): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\.+$/g, '')
    .slice(0, 96)
    .trim();
  return cleaned || fallback;
}

export function clampRecordingEditorRange(startMs: number, endMs: number, durationMs: number): RecordingEditorRange {
  const duration = Math.max(1000, Number.isFinite(durationMs) ? Math.round(durationMs) : 1000);
  const start = Math.min(duration - 1, Math.max(0, Number.isFinite(startMs) ? Math.round(startMs) : 0));
  const end = Math.min(duration, Math.max(start + 1, Number.isFinite(endMs) ? Math.round(endMs) : duration));
  return { startMs: start, endMs: end, durationMs: duration };
}

/** Convert the two shared 0..1000 timeline handles to one ordered range. */
export function recordingEditorSelectionFromRatios(startRatio: number, endRatio: number, durationMs: number): RecordingEditorRange {
  const duration = Math.max(1000, Number.isFinite(durationMs) ? Math.round(durationMs) : 1000);
  const start = Math.min(1000, Math.max(0, Number.isFinite(startRatio) ? startRatio : 0));
  const end = Math.min(1000, Math.max(0, Number.isFinite(endRatio) ? endRatio : 1000));
  return clampRecordingEditorRange((start / 1000) * duration, (end / 1000) * duration, duration);
}

export function recordingEditorMarkerPercent(atMs: number, durationMs: number): number {
  const duration = Math.max(1, Number.isFinite(durationMs) ? durationMs : 1);
  return Math.min(100, Math.max(0, (Number.isFinite(atMs) ? atMs : 0) / duration * 100));
}

/** Convert a transport control's 0..1000 value to the video's millisecond clock. */
export function recordingEditorSeekTargetMs(controlValue: number, durationMs: number): number {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  const ratio = Math.min(1000, Math.max(0, Number.isFinite(controlValue) ? controlValue : 0));
  return Math.round((ratio / 1000) * duration);
}

/** Convert a timeline ratio to the same millisecond clock used by editor ranges. */
export function recordingEditorTimelineMsFromRatio(ratio: number, durationMs: number): number {
  return recordingEditorSeekTargetMs(ratio * 1000, durationMs);
}

/**
 * Keep editor playback inside the selected range when it is resumed. A click
 * outside the range is allowed to park the player there; the next Play snaps
 * to the nearest boundary, while the normal player transport remains free to
 * seek anywhere in the source clip.
 */
export function recordingEditorResumePosition(currentMs: number, startMs: number, endMs: number): { positionMs: number; constrainedEndMs: number } {
  const range = clampRecordingEditorRange(startMs, endMs, Math.max(endMs, startMs + 1));
  const current = Number.isFinite(currentMs) ? Math.round(currentMs) : range.startMs;
  if (current < range.startMs) return { positionMs: range.startMs, constrainedEndMs: range.endMs };
  if (current > range.endMs) return { positionMs: range.endMs, constrainedEndMs: range.endMs };
  return { positionMs: current, constrainedEndMs: range.endMs };
}
