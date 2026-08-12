// Arc Power - M17c per-device tuning-limits table (pure, DOM-free; unit-tested
// in test/pure-device-limits.test.ts).
//
// Replaces the GLOBAL pins (VOLT_OFFSET_MAX_V 0.234, STD_PL_MAX_W 252,
// EXTENDED_PL_MAX_W 315, TEMP_LIMIT_MAX_C 90, EXTENDED_TL 115) with a
// per-device override keyed on the PCI device id + the AIB identity
// (decode from pure/aib.ts). The table only:
//   (a) un-clamps cards the global pins wrongly capped (A750 voltage 0.285,
//       PL per AIB: LE 228 / ASRock 216 / BiFrost 235, TL per AIB: 90 C
//       documented), and
//   (b) caps known cards at documented ceilings so the UI never offers a
//       value the driver refuses (0x44000002/04/05 stays the honest floor).
//
// THE NO-MATCH PATH RETURNS THE DEFAULT ROW (round-1 S3): an unlisted card
// keeps today's behavior exactly - { powerLimitW: { max: 252 }, tempLimitC:
// { max: 90 } } stock / { 315 / 115 } extended (two shapes - the caller asks
// for stock or extended via defaultLimitsOf). That default row feeds the
// extended-confirm threshold + ocModeRefusal's thresholds; the LISTED rows
// carry the documented PL AND TL ceilings (round-3 N3 - PL-only was an
// accidental gap: on a listed card whose driver reports an extended TL >
// the documented ceiling, the table caps it so (90, 115] is never offered).
//
// The table keys on pciDeviceId FIRST, then the AIB fields for the per-AIB
// PL rows. All table values carry a source comment (oc-corner / SkatterBencher
// / Intel Community / M15 live probe). Driver props stay the runtime
// authority (what IGS reads); this table only pins what is DOCUMENTED.

export interface DeviceLimitsInput {
  /** The device's PCI device id (the caps pciDeviceId field, e.g. '0x000056a0'). */
  pciDeviceId: string | null | undefined;
  /** The decoded AIB vendor (pure/aib.ts), e.g. 'ASRock' / 'Intel (Limited Edition)'. */
  aibVendor: string | null | undefined;
  /** The decoded AIB model, e.g. 'Phantom Gaming 8GB'. */
  aibModel: string | null | undefined;
}

/** The Arc A770 PCI device id (the dev-box card - the M15 probe evidence;
 *  the renderer's device-scoped voltage pin + the table key on it). */
export const A770_PCI_DEVICE_ID = '0x000056a0';
/** The Arc A750 PCI device id (verified from pci-ids.ucw.cz/read/PC/8086:
 *  'DG2 [Arc A750]'). */
export const A750_PCI_DEVICE_ID = '0x000056a1';

/** A per-control override - the exposed max (+ optionally the step). A row
 *  may carry only a subset of the controls; `max` is present on the
 *  clamping overrides only. */
export interface ControlLimit {
  max?: number;
  step?: number;
  /** M17c (A750): the explicit allow shape - the global 0.234 V clamp must
   *  NOT apply to this card; the driver's own voltage props pass through
   *  (the A750's 0.285, probe-documented). */
  unclamp?: boolean;
}

/** One device row of the table. */
export interface DeviceLimits {
  /** True when the device matched a LISTED row (not the default row) - the
   *  advanced-ceiling gate: a listed card's advanced ceiling comes from the
   *  LISTED row, never the default 315/115 (round-2 S8). */
  listed: boolean;
  powerLimitW?: ControlLimit;
  tempLimitC?: ControlLimit;
  gpuVoltOffsetV?: ControlLimit;
}

// ---------------------------------------------------------------------------
// The listed rows (documented entries only; sources in the comments)
// ---------------------------------------------------------------------------

/** The Arc A770 (pciDeviceId 0x56A0 - the dev-box card):
 *  - gpuVoltOffsetV max 0.234: the M15 live probe (2026-08-11,
 *    pipeline/live-volt-max-probe.mjs, this machine): 0.235 refused with
 *    0x44000002 on the current driver (32.0.101.8864) - the pin becomes
 *    A770-scoped (other V-unit cards keep their driver props);
 *  - PL 228: oc-corner A750 guide + SkatterBencher #64 (A770 LE) - the
 *    Intel (Limited Edition) ceiling;
 *  - TL 90: oc-corner / SkatterBencher (the documented 90 C TL max). */
const A770_ROW: DeviceLimits = {
  listed: true,
  gpuVoltOffsetV: { max: 0.234, step: 0.001 }, // M15 live probe (this box, 2026-08-11); the step 0.001 rides with the max - the driver's 0.005 step puts 0.234 OFF-GRID (a main-side clampSettings snap would turn 0.234 into 0.235 and get refused)
  tempLimitC: { max: 90 }, // oc-corner / SkatterBencher
};

/** The Arc A750 (pciDeviceId 0x56A1 - verified from pci-ids.ucw.cz/read/PC/8086:
 *  'DG2 [Arc A750]'):
 *  - gpuVoltOffsetV: NO override - the global 0.234 clamp must NOT apply
 *    (the driver's 0.285 passes through; the A750 IGS slider shows 285 mV -
 *    the user's report). Modeled as the explicit { unclamp: true } allow
 *    shape, pinned by the A750 volt range test;
 *  - PL per AIB: LE 228 (oc-corner A750 guide) / ASRock 216 (Intel
 *    Community - the ASRock A750 Challenger 216 W max, the user's stock
 *    card) / 235 when the aibModel contains 'BiFrost' or 'Predator'
 *    (Reddit/overclock.net: BiFrost 235 W Turbo - the documented row,
 *    unreachable until the decode names are probed, pinned via a DIRECT
 *    model match). An UNKNOWN AIB gets no PL override - the driver props
 *    stay the runtime authority (no documented ceiling to claim);
 *  - TL 90: oc-corner (the documented A750 TL max). */
const A750_ROW: DeviceLimits = {
  listed: true,
  gpuVoltOffsetV: { unclamp: true }, // A750: the driver's 0.285 passes through (user report)
  tempLimitC: { max: 90 }, // oc-corner
};

/** Resolve the A750 per-AIB PL ceiling - the documented rows (oc-corner LE
 *  228, Intel Community ASRock 216, Reddit/overclock.net BiFrost 235 Turbo);
 *  null when the AIB is unknown (no documented ceiling to claim; the driver
 *  props stay the authority). */
function a750PlMaxOf(input: DeviceLimitsInput): number | undefined {
  const vendor = typeof input.aibVendor === 'string' ? input.aibVendor : null;
  const model = typeof input.aibModel === 'string' ? input.aibModel : null;
  if (vendor === 'Intel (Limited Edition)') return 228; // oc-corner / SkatterBencher
  if (vendor === 'ASRock') return 216; // Intel Community (the ASRock A750 Challenger)
  if (/bifrost|predator/i.test(model ?? '')) return 235; // Reddit/overclock.net (the documented BiFrost row - model-match pinned)
  return undefined;
}

/** Resolve the A770 per-AIB PL ceiling - ONLY the Intel (Limited Edition)
 *  228 W row is documented for the A770 (oc-corner / SkatterBencher); an
 *  ASRock/unknown A770 gets no PL override (the driver props stay the
 *  runtime authority - the dev-box ASRock A770 keeps 252/315). */
function a770PlMaxOf(input: DeviceLimitsInput): number | undefined {
  return typeof input.aibVendor === 'string' && input.aibVendor === 'Intel (Limited Edition)'
    ? 228
    : undefined;
}

/** The listed rows keyed on the PCI device id (the canonical '0x0000xxxx'
 *  caps/DeviceInfo rendering). */
const LISTED_ROWS: Record<string, (input: DeviceLimitsInput) => DeviceLimits> = {
  // The A770: 0x56A0 (the dev-box card - the M15 probe evidence).
  [A770_PCI_DEVICE_ID]: (input) => {
    const pl = a770PlMaxOf(input);
    return {
      ...A770_ROW,
      ...(pl !== undefined ? { powerLimitW: { max: pl } } : {}),
    };
  },
  // The A750: 0x56A1 (pci-ids-verified). The AIB-specific PL row (LE 228 /
  // ASRock 216 / BiFrost 235); an unknown AIB keeps no PL override.
  [A750_PCI_DEVICE_ID]: (input) => {
    const pl = a750PlMaxOf(input);
    return {
      ...A750_ROW,
      ...(pl !== undefined ? { powerLimitW: { max: pl } } : {}),
    };
  },
};

/**
 * M17c: the per-device limits row. Keys on pciDeviceId FIRST (the listed
 * rows), then the AIB fields for the per-AIB PL ceilings. THE NO-MATCH PATH
 * RETURNS THE DEFAULT ROW (round-1 S3): an unlisted card keeps today's
 * behavior exactly (252 W / 90 C - the stock shape; the extended 315 / 115
 * shape comes from defaultLimitsOf(true)) - never null for a usable device
 * identity, so no stock-mode gap opens between the slider and the apply
 * gates. Null ONLY for a garbage input (no identity at all) - the defensive
 * degrade. The row's `listed` flag distinguishes the two (the run-B
 * advanced-ceiling gate: a listed card's advanced ceiling comes from the
 * LISTED row, never the default 315/115 - round-2 S8).
 * @param {DeviceLimitsInput} input the device identity (caps pciDeviceId +
 *   the decoded AIB fields)
 * @returns {DeviceLimits | null}
 */
export function deviceLimitsOf(input: DeviceLimitsInput | null | undefined): DeviceLimits | null {
  if (!input || typeof input !== 'object') return null;
  const pciId = typeof input.pciDeviceId === 'string' ? input.pciDeviceId.toLowerCase() : '';
  const rowFactory = pciId.length > 0 ? LISTED_ROWS[pciId] : undefined;
  if (!rowFactory) return defaultLimitsOf(false);
  return rowFactory(input);
}

/**
 * M17c: THE NO-MATCH PATH - the default row (today's pins exactly): an
 * unlisted card keeps the current behavior - 252 W / 90 C stock, 315 W /
 * 115 C extended (the two shapes the plan pins - the caller asks for stock
 * or extended). Never null.
 * @param {boolean} extended true when the extended (2023-runtime) range set
 *   applies
 * @returns {DeviceLimits}
 */
export function defaultLimitsOf(extended: boolean): DeviceLimits {
  return extended
    ? { listed: false, powerLimitW: { max: 315 }, tempLimitC: { max: 115 } } // M3-C-D: the live-verified 315 W ceiling
    : { listed: false, powerLimitW: { max: 252 }, tempLimitC: { max: 90 } };
}
