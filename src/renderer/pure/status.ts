// Arc Power — GPU health row model (pure, DOM-free; shared by the dashboard
// health card).
//
// M3-A rework: the IGS service indicator is REMOVED (with the M2C-C elevation
// gate, IGS state is no longer relevant to OC-applicability — the user's
// decision, docs). The old health + IGS combined mapping (mapStatus /
// IGS_LABELS / igsHalfState / IGS_NOTE) is gone; the general GPU HEALTH card
// replaces the merged Service Status card with five honest rows:
//
//   driver — "Driver installed": the IGCL runtime loaded + a driver version;
//   device — "Device detected": a GPU is enumerated (or the boot error);
//   clocks — "Clocks normal": the device clock is sane and the live telemetry
//            clock reads in range (refreshed in place on telemetry ticks);
//   oc — "OC working": the last apply outcome (ok / failed / never applied);
//   app — "Arc Power working": booted, backend live, mock badge when mock.
//
// Each row carries a level (ok/warn/error/unknown) + a human detail line.
// The legacy health-only level mapping (healthLevel) stays for the header
// test contract.

import type { Capabilities, DeviceInfo, HealthReport, LastApply, TelemetrySample } from '../types.ts';

export type HealthLevel = 'ok' | 'warn' | 'error' | 'unknown';

/** The five health-card rows (pinned by unit tests and --ui-verify). */
export type HealthRowId = 'driver' | 'device' | 'clocks' | 'oc' | 'app';

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
 * A boot error with no report reads as an error (the app is up, the driver
 * side is not).
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
  return { id: 'driver', label: 'Driver installed', level: 'ok', detail: `IGCL loaded, driver ${h.driverVersion}` };
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
 * "Clocks normal": the device's advertised graphics clock is sane (> 0) and
 * the latest telemetry sample (when present) reads a plausible in-range
 * clock. The telemetry clock is read at render time; the dashboard refreshes
 * this row in place on telemetry ticks (it is NOT a full-render slot).
 */
export function clocksRow(input: HealthInput): HealthRow {
  if (!input.device) {
    return input.bootError
      ? { id: 'clocks', label: 'Clocks normal', level: 'error', detail: input.bootError }
      : { id: 'clocks', label: 'Clocks normal', level: 'unknown', detail: 'No device yet' };
  }
  const saneBase = input.device.graphicsClockMHz > 0;
  const clock = input.sample?.gpuClockMhz;
  if (!saneBase) {
    return { id: 'clocks', label: 'Clocks normal', level: 'warn', detail: 'Device reports no graphics clock' };
  }
  if (clock !== undefined && !(Number.isFinite(clock) && clock > 0 && clock <= 4000)) {
    return { id: 'clocks', label: 'Clocks normal', level: 'warn', detail: `Telemetry clock reads ${clock} MHz` };
  }
  return clock === undefined
    ? { id: 'clocks', label: 'Clocks normal', level: 'ok', detail: `${input.device.graphicsClockMHz} MHz (waiting for live telemetry)` }
    : { id: 'clocks', label: 'Clocks normal', level: 'ok', detail: `${Math.round(clock)} MHz live` };
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
 * "Arc Power working": the app booted, the backend answered, and (mock mode)
 * the mock badge is reported honestly.
 */
export function appRow(input: HealthInput): HealthRow {
  if (input.health) {
    const mock = input.health.backend === 'mock' ? ' — mock backend' : '';
    return { id: 'app', label: 'Arc Power working', level: 'ok', detail: `App running, backend ${input.health.backend}${mock}` };
  }
  if (input.bootError) {
    return { id: 'app', label: 'Arc Power working', level: 'error', detail: input.bootError };
  }
  return { id: 'app', label: 'Arc Power working', level: 'unknown', detail: 'Booting…' };
}

/** All five health rows in display order. */
export function healthRows(input: HealthInput): HealthRow[] {
  return [driverRow(input), deviceRow(input), clocksRow(input), ocRow(input), appRow(input)];
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
