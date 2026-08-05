// Arc Power — status level mapping (pure, DOM-free; shared by the GPU header
// and the dashboard).
//
// The health report alone decides searching/ok/degraded/error (same semantics
// that used to live in components/header.ts — the F9 rule that a null health
// report reads as 'searching' still holds). The combined mapping additionally
// raises a `warning` on the IGS HALF-states (docs/igcl-integration.md §8a,
// verified rule): the service running without the app, or the app running
// without the service — both block OC writes. Fully-on (app + service) and
// fully-off are both OK. degraded/error always win over the warning — a
// broken backend is worse than a blocked one.

import type { Capabilities, HealthReport, IgsServiceState } from '../types.ts';

export type StatusLevel = 'searching' | 'ok' | 'warning' | 'degraded' | 'error';

/**
 * IGS four-combination labels (pinned by unit tests and --ui-verify).
 * - half, service-on/app-off: the service enforces OC state with no app to
 *   expose it — writes are refused.
 * - half, service-off/app-on: the app holds OC state without the service —
 *   writes are refused as well.
 * - fully on / fully off: both verified to accept OC writes.
 */
export const IGS_LABELS = {
  fullyOn: 'IGS fully active — OC control OK',
  fullyOff: 'IGS fully off — OC control OK',
  serviceWithoutApp: 'IGS service running without the app — OC changes may not apply',
  appWithoutService: 'IGS app running without the service — OC changes may not apply',
} as const;

export const STATUS_LABEL: Record<StatusLevel, string> = {
  ok: 'Healthy',
  warning: IGS_LABELS.serviceWithoutApp,
  degraded: 'Degraded',
  error: 'Error',
  searching: 'Searching…',
};

/** Exact user-facing partial-running note (pinned by unit tests and --ui-verify). */
export const IGS_NOTE = 'Intel Graphics Software is partially running. For OC changes to apply, either disable IGS completely or run it fully with the Tuning tab enabled.';

/**
 * Verbose-label visibility in the dashboard status card (M2b step-5 NIT 3):
 * the label renders next to the dot ONLY for warning/degraded/error levels —
 * fully-on/fully-off (and the transient searching state) show just the dot,
 * with the full label carried by the dot's tooltip.
 */
export function labelForLevel(level: StatusLevel): string | null {
  if (level === 'warning' || level === 'degraded' || level === 'error') return STATUS_LABEL[level];
  return null;
}

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
 * IGS half-state predicate (service and app disagree) — the dashboard card's
 * note condition. Deliberately NOT gated on `service.found`: a failed/absent
 * service probe (e.g. non-1060 sc failure) with the app still running is
 * still the OC-write blocker, so the card must agree with the header warning.
 * @param igs null while the probe is pending — no half-state until we know.
 */
export function igsHalfState(igs: IgsServiceState | null): boolean {
  return !!igs && igs.service.running !== igs.appRunning;
}

/**
 * Combined health + IGS mapping.
 * @param igs null while the probe is pending — no warning until we know.
 */
export function mapStatus(health: HealthReport | null, igs: IgsServiceState | null): StatusOutcome {
  const base = healthLevel(health);
  if (base !== 'ok' || !igs) return { level: base, label: STATUS_LABEL[base] };
  const svc = igs.service;
  // Half-states block OC writes — warn with the direction-specific label.
  if (svc.running !== igs.appRunning) {
    const label = svc.running ? IGS_LABELS.serviceWithoutApp : IGS_LABELS.appWithoutService;
    return { level: 'warning', label };
  }
  // Fully on (service + app) and fully off are both OK.
  return { level: 'ok', label: svc.running ? IGS_LABELS.fullyOn : IGS_LABELS.fullyOff };
}

// ---------------------------------------------------------------------------
// Dashboard re-render scoping (M2a.5-5)
// ---------------------------------------------------------------------------

/**
 * The store slots that drive the dashboard's static content (device card,
 * merged status card). Telemetry ticks only touch `latestSample` — those
 * must NOT trigger a full page rebuild; the dashboard refreshes the readout
 * grid in place instead. driverDate is fetched once at boot (it can arrive
 * after the first render, so it counts as a status slot).
 */
export interface DashboardSig {
  igsState: IgsServiceState | null;
  health: HealthReport | null;
  caps: Capabilities | null;
  bootError: string | null;
  driverDate: string | null;
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
    || prev.bootError !== next.bootError
    || prev.driverDate !== next.driverDate;
}
