// Arc Power — status level mapping (pure, DOM-free; shared by the GPU header
// and the dashboard).
//
// The health report alone decides searching/ok/degraded/error (same semantics
// that used to live in components/header.ts — the F9 rule that a null health
// report reads as 'searching' still holds). The combined mapping additionally
// raises a `warning` when the device is healthy BUT the IGS service is
// running: the service blocks OC writes (docs/igcl-integration.md §8a), so
// healthy-but-blocked is the state the user must see. degraded/error always
// win over the warning — a broken backend is worse than a blocked one.

import type { Capabilities, HealthReport, IgsServiceState } from '../types.ts';

export type StatusLevel = 'searching' | 'ok' | 'warning' | 'degraded' | 'error';

export const STATUS_LABEL: Record<StatusLevel, string> = {
  ok: 'Healthy',
  warning: "IGS service running — OC changes won't apply",
  degraded: 'Degraded',
  error: 'Error',
  searching: 'Searching…',
};

/** Health-only level (kept separate so the header test contract stays exact). */
export function healthLevel(h: HealthReport | null): StatusLevel {
  if (!h) return 'searching'; // no health report yet — boot in progress
  if (h.error) return 'error';
  if (!h.igclLoaded || !h.levelZeroOk) return 'degraded';
  return 'ok';
}

export interface StatusOutcome {
  level: StatusLevel;
  label: string;
}

/**
 * Combined health + IGS service mapping.
 * @param igs null while the probe is pending — no warning until we know.
 */
export function mapStatus(health: HealthReport | null, igs: IgsServiceState | null): StatusOutcome {
  const base = healthLevel(health);
  if (base === 'ok' && igs?.running) {
    return { level: 'warning', label: STATUS_LABEL.warning };
  }
  return { level: base, label: STATUS_LABEL[base] };
}

// ---------------------------------------------------------------------------
// Dashboard re-render scoping (M2a.5-5)
// ---------------------------------------------------------------------------

/**
 * The store slots that drive the dashboard's static content (device card,
 * health card, IGS card). Telemetry ticks only touch `latestSample` — those
 * must NOT trigger a full page rebuild; the dashboard refreshes the readout
 * grid in place instead.
 */
export interface DashboardSig {
  igsState: IgsServiceState | null;
  health: HealthReport | null;
  caps: Capabilities | null;
  bootError: string | null;
}

/**
 * Full re-render decision for the dashboard's onUpdate: re-render when a
 * status slot changed (boot probe, IGS toggle refresh, boot errors), not on
 * telemetry ticks. The first update (prev === null) always renders.
 */
export function dashboardNeedsFullRender(prev: DashboardSig | null, next: DashboardSig): boolean {
  if (prev === null) return true;
  return prev.igsState !== next.igsState
    || prev.health !== next.health
    || prev.caps !== next.caps
    || prev.bootError !== next.bootError;
}
