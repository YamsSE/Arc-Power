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

export function recordingEditorMarkerPercent(atMs: number, durationMs: number): number {
  const duration = Math.max(1, Number.isFinite(durationMs) ? durationMs : 1);
  return Math.min(100, Math.max(0, (Number.isFinite(atMs) ? atMs : 0) / duration * 100));
}
