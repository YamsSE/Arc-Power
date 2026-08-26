// Arc Power - GPU health row model (pure, DOM-free; shared by the dashboard
// health card).
//
// M3-A rework: the IGS service indicator is REMOVED (with the M2C-C elevation
// gate, IGS state is no longer relevant to OC-applicability - the
// decision, docs). The old health + IGS combined mapping (mapStatus /
// IGS_LABELS / igsHalfState / IGS_NOTE) is gone; the general GPU HEALTH card
// replaces the merged Service Status card. M3-C-I trims it to four honest
// rows (the "Clocks normal" row is REMOVED per the dashboard picture):
//
//   driver - "Driver installed": the IGCL runtime loaded + a driver version;
//            the detail shows the driver version + date like the device card
//            (driverLine: "32.0.101.8861 - Jul 05, 2026");
//   device - "Device detected": a GPU is enumerated (or the boot error);
//            M16: this row renders ABOVE the driver row (the flip);
//   oc - "OC status" (M16 rename of "OC Status"): the STOCK-STATE verdict -
//        "No Overclock Applied" / "Overclock Applied" (the M4-B last-apply
//        outcome is no longer displayed here);
//   waiver - "OC waiver": the LIVE waiver status (Accepted ok / Not Accepted
//            error) - the ONLY persistent waiver display in the app (user
//            correction, mid-M4-A: not on the OC or Fan pages);
//   app - "Arc Power working": booted, backend live - healthy detail reads
//         "App & Service Running" (app-only, NO IGS probe).
//
// Each row carries a level (ok/warn/error/unknown) + a human detail line.
// The legacy health-only level mapping (healthLevel) stays for the header
// test contract.

import type { Capabilities, DeviceInfo, DeviceState, HealthReport, SysInfo, TelemetrySample, VendorDeviceInfo } from '../types.ts';
import { decodeDriverVersion, formatDriverDate } from './driver.ts';

export type HealthLevel = 'ok' | 'warn' | 'error' | 'unknown';

/** The five health-card rows (pinned by unit tests and --ui-verify). */
export type HealthRowId = 'driver' | 'device' | 'oc' | 'waiver' | 'app';

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
  bootError: string | null;
  /** M3-C-I: the display-driver registry date for the driver row detail. */
  driverDate: string | null;
  /**
   * M4-A: the LIVE waiver flag (caps.waiverAccepted); null while no device
   * caps have landed (the row then reads "Waiting for device…" - never a
   * false Accepted/Not Accepted).
   */
  waiverAccepted: boolean | null;
  /**
   * M17: FALSE on OC-locked devices (caps.overclockingSupported === false) -
   * there is no waiver to accept; the row reads the neutral
   * "Not supported on this GPU" (ok, never the clickable error state).
   */
  overclockingSupported?: boolean | null;
  /**
   * M16: the device's current read-back (getCurrentSettings) - the OC status
   * row's source: stock vs non-stock is derived from the ACTUAL driver
   * values vs the capability defaults, never from the last apply outcome.
   */
  state: DeviceState | null;
  /**
   * M16: the capability ranges (the stock defaults' source - every control's
   * `default` is the stock value; power/temperature defaults are the
   * DriverStore values, so a 90 C limit in an extended session still reads
   * stock).
   */
  caps: Capabilities | null;
  /**
   * 1.0.1 no-Intel round: FALSE when the app runs in the no-device mode
   * (no Intel GPU enumerated) - the driver/device rows then swap to the
   * honest no-Intel texts ('No Intel Driver Found' / the OS GPU name),
   * NEVER the raw IGCL/error text.
   */
  hasIntelGpu?: boolean;
  /** 1.0.1 no-Intel round: the OS GPU name (sysinfo primary video
   *  controller) for the device row on the no-Intel path. */
  osGpuName?: string | null;
}

/** Legacy health-only level (kept so the header test contract stays exact). */
export function healthLevel(h: HealthReport | null): HealthLevel {
  if (!h) return 'unknown'; // no health report yet - boot in progress
  if (h.error) return 'error';
  if (!h.igclLoaded || !h.levelZeroOk) return 'warn';
  return 'ok';
}

/** The worst (most severe) of a set of levels - error > warn > unknown > ok. */
export function worstLevel(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('error')) return 'error';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('unknown')) return 'unknown';
  return 'ok';
}

/**
 * "Driver installed": the IGCL runtime loaded AND a driver version is known.
 * The ok detail shows the driver version + date exactly like the device card
 * does (driverLine: "32.0.101.8861 - Jul 05, 2026") - M3-C-I. A boot error
 * with no report reads as an error (the app is up, the driver side is not).
 * 1.0.1 no-Intel round: on the no-device path (hasIntelGpu false) the row
 * reads 'No Intel Driver Found' (warn) - the raw IGCL/error text must NEVER
 * surface there (checked BEFORE every error branch).
 */
export function driverRow(input: HealthInput): HealthRow {
  if (input.hasIntelGpu === false) {
    return { id: 'driver', label: 'Driver installed', level: 'warn', detail: 'No Intel Driver Found' };
  }
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
  // device's own driverVersion (the device card's source - the mock device
  // reports a clean dotted string while the health report appends a mock
  // suffix), fall back to the health report's.
  const raw = input.device?.driverVersion ?? h.driverVersion;
  const version = decodeDriverVersion(raw) ?? raw;
  const date = formatDriverDate(input.driverDate);
  return { id: 'driver', label: 'Driver installed', level: 'ok', detail: date ? `${version} - ${date}` : version };
}

/**
 * "Device detected": the GPU is enumerated (or the boot error says why not).
 * 1.0.1 no-Intel round: on the no-device path the row shows the OS GPU name
 * (warn - no error text, no "searching" state).
 */
export function deviceRow(input: HealthInput): HealthRow {
  if (input.hasIntelGpu === false) {
    return { id: 'device', label: 'Device detected', level: 'warn', detail: input.osGpuName ?? 'No GPU detected' };
  }
  if (input.device) {
    return { id: 'device', label: 'Device detected', level: 'ok', detail: input.device.name };
  }
  if (input.bootError) {
    return { id: 'device', label: 'Device detected', level: 'error', detail: input.bootError };
  }
  return { id: 'device', label: 'Device detected', level: 'unknown', detail: 'Searching for a graphics device…' };
}

/**
 * M16: whether the device currently runs STOCK values. Stock = every
 * SUPPORTED control's driver value equals its capability default:
 *   - the scalar controls gpuFreqOffsetMhz / gpuVoltOffsetV (default 0),
 *     powerLimitW / tempLimitC (the DriverStore defaults - a 90 C / 210 W
 *     session in an EXTENDED range is still stock) AND the two expert
 *     scalars vramFreqOffsetGts / vramVoltOffsetV - the latter two are
 *     judged ONLY when caps.ranges[key] exists (the same range-presence
 *     gate as the four main controls scopes them per device - a b580 VRAM
 *     offset is a real overclock, so it must flip the verdict);
 *   - gpuLock - judged when caps.controls.gpuLock is true, against the
 *     UNLOCKED shape { voltageV: 0, freqMhz: 0 } (the mock's stock shape
 *     and the backend's documented unlocked read-back; any non-zero pair
 *     is a lock = Overclock Applied);
 *   - vfCurve (M16-F1) - judged when caps.controls.vfCurve is true (the
 *     same no-range controls flag gate as gpuLock; DeviceState.vfCurve is
 *     null when the control is unsupported). The STOCK reference is the
 *     EMPTY/ABSENT shape: null or [] - the mock's stock read-back is null
 *     and an apply stores a sanitized NON-EMPTY array, so any non-empty
 *     curve is a real custom V/F curve = Overclock Applied.
 * Fan controls are deliberately EXCLUDED (fan is cooling, not
 * overclocking) - documented scope. Unsupported controls are never judged
 * (absent range / control -> skipped). "ANYTHING BUT Stock = Overclock
 * Applied". True only when both state and caps exist; null when they are
 * missing (nothing to judge). M16 (B4): the comparison uses the documented
 * STOCK_COMPARE_EPS (1e-6) - a driver read-back with tiny float drift
 * (e.g. powerLimit 210.0000001) must still read stock.
 * M16 (B3 - documented boundary): the verdict derives from `state`,
 * refreshed at boot / device-switch / apply. An EXTERNAL change (made
 * outside this app, e.g. through Intel Graphics Software) after the last
 * refresh is NOT detected until the next boot/switch/apply - the row can
 * claim stock while the driver actually differs (the same class of
 * limitation the old last-apply row had). M16-F1 extends the boundary
 * note to vfCurve: the REAL backend reads the driver curve blindly
 * (igcl-backend.js getCurrentSettings -> ctlOverclockReadVFCurve) - if a
 * stock Battlemage device reports a NON-NULL default curve the verdict
 * reads Overclock Applied until a refresh shows the empty/absent shape
 * (verified on hardware before relying on the empty default).
 */
export const STOCK_COMPARE_EPS = 1e-6;

const UNLOCKED_LOCK = { voltageV: 0, freqMhz: 0 };

export function isStockState(state: DeviceState | null, caps: Capabilities | null): boolean | null {
  if (!state || !caps) return null;
  for (const key of ['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'powerLimitW', 'tempLimitC', 'vramFreqOffsetGts', 'vramVoltOffsetV']) {
    const range = caps.ranges[key];
    if (!range) continue; // unsupported on this device - never judged
    const value = state[key as keyof DeviceState];
    if (typeof value !== 'number' || typeof range.default !== 'number') continue;
    if (Math.abs(value - range.default) > STOCK_COMPARE_EPS) return false;
  }
  // gpuLock: supported when caps.controls.gpuLock says so (no range
  // exists for the lock pair - the controls flag is the gate). The
  // unlocked { 0, 0 } shape is stock; any non-zero pair is a real lock.
  if (caps.controls.gpuLock === true && state.gpuLock) {
    if (Math.abs(state.gpuLock.voltageV - UNLOCKED_LOCK.voltageV) > STOCK_COMPARE_EPS
      || Math.abs(state.gpuLock.freqMhz - UNLOCKED_LOCK.freqMhz) > STOCK_COMPARE_EPS) {
      return false;
    }
  }
  // vfCurve (M16-F1): judged when caps.controls.vfCurve says so (same
  // controls-flag gate as gpuLock - DeviceState.vfCurve is null when the
  // control is unsupported, never judged then). The stock reference is the
  // EMPTY/ABSENT shape: the mock's stock read-back is vfCurve: null and an
  // apply stores a sanitized NON-EMPTY array, so any non-empty array is a
  // real custom V/F curve = Overclock Applied (a profile-applied curve on
  // Battlemage must never read "No Overclock Applied").
  if (caps.controls.vfCurve === true && Array.isArray(state.vfCurve) && state.vfCurve.length > 0) {
    return false;
  }
  return true;
}

/**
 * "OC status" (M16 - renamed from "OC Status", RE-USED as the stock-state
 * indicator): shows ONLY "No Overclock Applied" (the device runs stock) or
 * "Overclock Applied" (ANY supported control differs from its stock
 * default - see isStockState) - the last-apply outcome is no longer
 * displayed here. Unknown while no state/caps have landed; the no-Intel
 * path reads the honest no-OC text.
 */
export function ocRow(input: HealthInput): HealthRow {
  if (input.hasIntelGpu === false) {
    return { id: 'oc', label: 'OC status', level: 'ok', detail: 'No Overclock Applied' };
  }
  const stock = isStockState(input.state, input.caps);
  if (stock === null) {
    return { id: 'oc', label: 'OC status', level: 'unknown', detail: 'Waiting for device…' };
  }
  return stock
    ? { id: 'oc', label: 'OC status', level: 'ok', detail: 'No Overclock Applied' }
    : { id: 'oc', label: 'OC status', level: 'ok', detail: 'Overclock Applied' };
}

/**
 * M4-A: "OC waiver" - the LIVE waiver acceptance status, the ONLY persistent
 * waiver display in the app (correction, mid-M4-A: the dashboard's GPU
 * Health card, NOT the OC/Fan pages). Reads caps.waiverAccepted at render
 * time; the dashboard full-re-renders on caps changes (its sig includes
 * caps), so an accept-time store patch refreshes this row. Unknown while no
 * caps have landed. M17 (B50-class): on OC-locked devices there is no
 * waiver - the row reads the neutral "Not supported on this GPU" (ok level,
 * never clickable) instead of an un-answerable "Not Accepted" error.
 */
export function waiverRow(input: HealthInput): HealthRow {
  if (input.overclockingSupported === false) {
    return { id: 'waiver', label: 'OC waiver', level: 'ok', detail: 'Not supported on this GPU' };
  }
  if (input.waiverAccepted === null) {
    return { id: 'waiver', label: 'OC waiver', level: 'unknown', detail: 'Waiting for device…' };
  }
  return input.waiverAccepted
    ? { id: 'waiver', label: 'OC waiver', level: 'ok', detail: 'Accepted' }
    : { id: 'waiver', label: 'OC waiver', level: 'error', detail: 'Not Accepted' };
}

/**
 * "Arc Power working": the app booted and the backend answered. M3-C-I: the
 * healthy detail reads "App & Service Running" (app-only - the app's own
 * engine/backend; NO IGS probe, per the decision). Honest warn/error
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

/** All health rows in display order (M3-C-I: the clocks row is removed;
 *  M4-A: the waiver row sits between the OC and app rows; M16: the device
 *  row moves ABOVE the driver row - "Flip 'Driver Installed' Row and
 *  'Device Installed' Row"). */
export function healthRows(input: HealthInput): HealthRow[] {
  return [deviceRow(input), driverRow(input), ocRow(input), waiverRow(input), appRow(input)];
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
 * GPU health card, M4-D CPU & memory card). Telemetry ticks only touch
 * `latestSample` - those must NOT trigger a full page rebuild; the
 * dashboard refreshes the readout grid and the clocks row in place instead.
 * driverDate is fetched once at boot (it can arrive after the first render,
 * so it counts as a status slot). M4-D: `sysinfo` lands once at boot (the
 * CPU card must re-render when it arrives - the boot fetch is fire-and-
 * forget, so it can land after the first render). M3-A: the IGS slot is
 * gone (no longer surfaced). M16: the M4N `lastApply` slot LEFT the
 * signature (the OC row no longer displays the last-apply outcome) - the
 * device read-back `state` joined in its place: the row's stock-state
 * verdict needs a re-render when the read-back lands or changes (an apply
 * from ANY path refreshes the store state).
 */
export interface DashboardSig {
  health: HealthReport | null;
  caps: Capabilities | null;
  bootError: string | null;
  driverDate: string | null;
  /** M4-D: the system-info payload (CPU & memory card source). */
  sysinfo: SysInfo | null;
  /** 1.0.1 no-Intel round: the no-device flag + the OS GPU - status slots
   *  (the GPU card re-renders when they land at the end of the no-Intel
   *  boot). */
  noIntel: boolean;
  osGpu: {
    name: string;
    vramBytes: number | null;
    sharedMemoryBytes?: number | null;
    sharedMemorySource?: string | null;
    pnpDeviceId: string | null;
  } | null;
  /** M17d: the vendor-lane static info (the no-Intel VRAM/Compute rows'
   *  source) - a status slot (the GPU card re-renders when it lands). */
  vendorInfo: VendorDeviceInfo | null;
  /** M16: the device's current read-back - the OC status row's stock-state
   *  source (an apply from ANY path refreshes the store state, so the row
   *  flips Overclock Applied / No Overclock Applied on the re-render). */
  state: DeviceState | null;
  /** Device inventory identity/data, including late shared-memory enrichment. */
  devices?: DeviceInfo[];
}

/**
 * Full re-render decision for the dashboard's onUpdate: re-render when a
 * status slot changed (boot probe, boot errors, the sysinfo landing, the
 * boot-apply outcome landing), not on telemetry ticks. The first update
 * (prev === null) always renders.
 */
export function dashboardNeedsFullRender(prev: DashboardSig | null, next: DashboardSig): boolean {
  if (prev === null) return true;
  return prev.health !== next.health
    || prev.caps !== next.caps
    || prev.bootError !== next.bootError
    || prev.driverDate !== next.driverDate
    || prev.sysinfo !== next.sysinfo
    || prev.noIntel !== next.noIntel
    || prev.osGpu !== next.osGpu
    || prev.vendorInfo !== next.vendorInfo
    || prev.state !== next.state
    || prev.devices !== next.devices;
}
