// User-facing recording messages stay independent of the bundled runtime's
// internal product name.

export const RECORDING_BITRATE_RANGES = {
  default: { min: 4000, max: 8000, step: 100, default: 8000, label: '4,000–8,000 Kbps' },
  '480p': { min: 1500, max: 2500, step: 100, default: 2000, label: '1,500–2,500 Kbps' },
  '720p': { min: 2500, max: 5000, step: 100, default: 3500, label: '2,500–5,000 Kbps' },
  '900p': { min: 3500, max: 7000, step: 100, default: 5000, label: '3,500–7,000 Kbps' },
  '1080p': { min: 4000, max: 8000, step: 100, default: 6000, label: '4,000–8,000 Kbps' },
  '1440p': { min: 8000, max: 12000, step: 100, default: 10000, label: '8,000–12,000 Kbps' },
  '4k': { min: 15000, max: 50000, step: 500, default: 20000, label: '15,000–25,000+ Kbps' },
} as const;

export function recordingBitrateRange(resolution: string) {
  return RECORDING_BITRATE_RANGES[resolution as keyof typeof RECORDING_BITRATE_RANGES] ?? RECORDING_BITRATE_RANGES.default;
}

// Bitrate is intentionally never clamped or rewritten. This message only
// explains when a chosen value is below the resolution's practical minimum,
// which is the situation that makes a higher-resolution file look softer
// despite using the same nominal encoder settings.
export function recordingBitrateWarning(resolution: string, bitrate: number): string | null {
  const range = recordingBitrateRange(resolution);
  if (!Number.isFinite(bitrate) || bitrate <= 0 || bitrate >= range.min) return null;
  const label = resolution === '4k' ? '4K' : resolution;
  return `Below the ${label} recommendation (${range.label}). Your bitrate will be used exactly, but this resolution needs more data for clean detail.`;
}

export function clampRecordingBitrate(value: number, resolution: string): number {
  const range = recordingBitrateRange(resolution);
  const numeric = Number.isFinite(value) ? Math.round(value) : range.default;
  const clamped = Math.min(range.max, Math.max(range.min, numeric));
  return Math.round(clamped / range.step) * range.step;
}

export function normalizeRecordingBitrate(value: number, fallback = 8000): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function recordingMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/ascent(?:-obs)?/gi, 'recording engine');
}
