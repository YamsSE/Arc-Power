// Arc Power — GPU health row model (pure, DOM-free; shared by the dashboard
// health card).
//
// M3-A rework: the IGS service indicator is REMOVED (with the M2C-C elevation
// gate, IGS state is no longer relevant to OC-applicability — the user's
// decision, docs). The old health + IGS combined mapping (mapStatus /
// IGS_LABELS / igsHalfState / IGS_NOTE) is gone; the general GPU HEALTH card
// replaces the merged Service Status card. M3-C-I trims it to four honest
// rows (the "Clocks normal" row is REMOVED per the user's dashboard picture):
//
//   driver — "Driver installed": the IGCL runtime loaded + a driver version;
//            the detail shows the driver version + date like the device card
//            (driverLine: "32.0.101.8861 - Jul 05, 2026");
//   device — "Device detected": a GPU is enumerated (or the boot error);
//   oc — "OC working": the last apply outcome (ok / failed / never applied);
//   app — "Arc Power working": booted, backend live — healthy detail reads
//         "App & Service Running" (app-only, NO IGS probe).
//
// Each row carries a level (ok/warn/error/unknown) + a human detail line.
// The legacy health-only level mapping (healthLevel) stays for the header
// test contract.

import type { Capabilities, DeviceInfo, HealthReport, LastApply, TelemetrySample } from '../types.ts';
import { decodeDriverVersion, formatDriverDate } from './driver.ts';

export type HealthLevel = 'ok' | 'warn' | 'error' | 'unknown';

/** The four health-card rows (pinned by unit tests and --ui-verify). */
export type HealthRowId = 'driver' | 'device' | 'oc' | 'app';

export interface HealthRow {
  id: HealthRowId;
  label: string;
  level: HealthLevel;
  /** Short human detail rendered next to the label (also the dot tooltip). */
  detail: string;
}

/** Everything the health card reads from the store (pure inputs). */
export interface HealthInput {
  health: HealthReport | null;
  device: DeviceInfo | null;
  sample: TelemetrySample | null;
  lastApply: LastApply | null;
  bootError: string | null;
  /** M3-C-I: the display-driver registry date for the driver row detail. */
  driverDate: string | null;
}

/** Legacy health-only level (kept so the header test contract stays exact). */
export function healthLevel(h: HealthReport | null): HealthLevel {
  if (!h) return 'unknown'; // no health report yet — boot in progress
  if (h.error) return 'error';
  if (!h.igclLoaded || !h.levelZeroOk) return 'warn';
  return 'ok';
}

/** The worst (most severe) of a set of levels — error > warn > unknown > ok. */
export function worstLevel(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('error')) return 'error';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('unknown')) return 'unknown';
  return 'ok';
}

/**
 * "Driver installed": the IGCL runtime loaded AND a driver version is known.
 * The ok detail shows the driver version + date exactly like the device card
 * does (driverLine: "32.0.101.8861 - Jul 05, 2026") — M3-C-I. A boot error
 * with no report reads as an error (the app is up, the driver side is not).
 */
export function driverRow(input: HealthInput): HealthRow {
  const h = input.health;
  if (!h) {
    return input.bootError
      ? { id: 'driver', label: 'Driver installed', level: 'error', detail: input.bootError }
      : { id: 'driver', label: 'Driver installed', level: 'unknown', detail: 'Waiting for the health report…' };
  }
  if (h.error || !h.igclLoaded) {
    return { id: 'driver', label: 'Driver installed', level: 'error', detail: h.error ?? 'IGCL runtime not loaded' };
  }
  if (!h.driverVersion) {
    return { id: 'driver', label: 'Driver installed', level: 'warn', detail: 'IGCL loaded, driver version unknown' };
  }
  // M3-C-I: version + date like the device card (driverLine). Prefer the
  // device's own driverVersion (the device card's source — the mock device
  // reports a clean dotted string while the health report appends a mock
  // suffix), fall back to the health report's.
  const raw = input.device?.driverVersion ?? h.driverVersion;
  const version = decodeDriverVersion(raw) ?? raw;
  const date = formatDriverDate(input.driverDate);
  return { id: 'driver', label: 'Driver installed', level: 'ok', detail: date ? `${version} - ${date}` : version };
}

/** "Device detected": the GPU is enumerated (or the boot error says why not). */
export function deviceRow(input: HealthInput): HealthRow {
  if (input.device) {
    return { id: 'device', label: 'Device detected', level: 'ok', detail: input.device.name };
  }
  if (input.bootError) {
    return { id: 'device', label: 'Device detected', level: 'error', detail: input.bootError };
  }
  return { id: 'device', label: 'Device detected', level: 'unknown', detail: 'Searching for a graphics device…' };
}

/**
 * "OC working": the last apply outcome — honest: never applied, last apply
 * ok, or last apply failed (with a hint of what failed).
 */
export function ocRow(input: HealthInput): HealthRow {
  const last = input.lastApply;
  if (!last) {
    return { id: 'oc', label: 'OC working', level: 'unknown', detail: 'No OC apply yet in this session' };
  }
  if (last.ok) {
    return { id: 'oc', label: 'OC working', level: 'ok', detail: last.detail ?? 'Last apply succeeded' };
  }
  return { id: 'oc', label: 'OC working', level: 'error', detail: last.detail ?? 'Last apply failed' };
}

/**
 * "Arc Power working": the app booted and the backend answered. M3-C-I: the
 * healthy detail reads "App & Service Running" (app-only — the app's own
 * engine/backend; NO IGS probe, per the user's decision). Honest warn/error
 * states as before.
 */
export function appRow(input: HealthInput): HealthRow {
  if (input.health) {
    return { id: 'app', label: 'Arc Power working', level: 'ok', detail: 'App & Service Running' };
  }
  if (input.bootError) {
    return { id: 'app', label: 'Arc Power working', level: 'error', detail: input.bootError };
  }
  return { id: 'app', label: 'Arc Power working', level: 'unknown', detail: 'Booting…' };
}

/** All health rows in display order (M3-C-I: the clocks row is removed). */
export function healthRows(input: HealthInput): HealthRow[] {
  return [driverRow(input), deviceRow(input), ocRow(input), appRow(input)];
}

/** Overall health-card level: the worst of the five rows. */
export function overallHealthLevel(rows: HealthRow[]): HealthLevel {
  return worstLevel(rows.map((r) => r.level));
}

// ---------------------------------------------------------------------------
// Dashboard re-render scoping (M2a.5-5)
// ---------------------------------------------------------------------------

/**
 * The store slots that drive the dashboard's static content (device card,
 * GPU health card). Telemetry ticks only touch `latestSample` — those must
 * NOT trigger a full page rebuild; the dashboard refreshes the readout grid
 * and the clocks row in place instead. driverDate is fetched once at boot
 * (it can arrive after the first render, so it counts as a status slot).
 * M3-A: the IGS slot is gone (no longer surfaced); the OC row reads
 * lastApply at render time (applies happen on other pages — the dashboard
 * re-renders on navigation).
 */
export interface DashboardSig {
  health: HealthReport | null;
  caps: Capabilities | null;
  bootError: string | null;
  driverDate: string | null;
}

/**
 * Full re-render decision for the dashboard's onUpdate: re-render when a
 * status slot changed (boot probe, boot errors), not on telemetry ticks. The
 * first update (prev === null) always renders.
 */
export function dashboardNeedsFullRender(prev: DashboardSig | null, next: DashboardSig): boolean {
  if (prev === null) return true;
  return prev.health !== next.health
    || prev.caps !== next.caps
    || prev.bootError !== next.bootError
    || prev.driverDate !== next.driverDate;
}
