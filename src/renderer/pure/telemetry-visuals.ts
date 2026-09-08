// Shared telemetry history and palette values used by the Dashboard
// Performance pulse and the Monitoring graphs. Keeping these values in one
// DOM-free module prevents the two surfaces from silently drifting apart.

/** The Performance pulse keeps the most recent sixty telemetry samples. */
export const TELEMETRY_HISTORY_POINTS = 60;

/** The stock telemetry cadence (M17g) used to translate samples to seconds. */
export const TELEMETRY_POLL_MS_DEFAULT = 400;

/**
 * The pulse's visible time span at the stock cadence. There are 59 intervals
 * between 60 samples; the renderer rounds this to 24 seconds for the label.
 */
export const TELEMETRY_HISTORY_WINDOW_S = ((TELEMETRY_HISTORY_POINTS - 1) * TELEMETRY_POLL_MS_DEFAULT) / 1000;
export const TELEMETRY_HISTORY_WINDOW_LABEL = `${Math.round(TELEMETRY_HISTORY_WINDOW_S)}-second`;

/**
 * Dashboard Performance pulse colors. Monitoring reuses the same semantic
 * colors for matching metrics and keeps the Arc accent for metrics without a
 * pulse counterpart.
 */
export const TELEMETRY_PULSE_COLORS = {
  utilization: '#43c7ff',
  temperature: '#f2b15b',
  power: '#b995ff',
  memory: '#55d6a5',
} as const;
