// Arc Power - M17c/M17d per-device tuning-limits table (pure, DOM-free;
// unit-tested in test/pure-device-limits.test.ts).
//
// Replaces the GLOBAL pins (VOLT_OFFSET_MAX_V 0.234, STD_PL_MAX_W 252,
// EXTENDED_PL_MAX_W 315, TEMP_LIMIT_MAX_C 90, EXTENDED_TL 115) with a
// per-device override keyed on the PCI device id + the AIB identity
// (decode from pure/aib.ts). The table only:
//   (a) un-clamps cards the global pins wrongly capped (A750 voltage 0.288,
//       PL per AIB: LE 228 / ASRock 216 / Acer 216 (the probe verdict - the
//       BiFrost 235 documented claim is REFUTED as a stock value on the
//       Acer card/driver, 2026-08-12), TL per AIB: 90 C documented), and
//   (b) caps known cards at documented ceilings so the UI never offers a
//       value the driver refuses (0x44000002/04/05 stays the honest floor).
//
// M17d: the STOCK/ADVANCED SPLIT (the round-3-N3 rule FLIPS). The M17c
// table conflated the STOCK max with the ADVANCED (KMD) ceiling - that is
// the A750 PL-regression root cause: a listed card's advanced ceiling is
// NOT the per-AIB stock max. The table now carries TWO shapes per row:
//   - STOCK (the default - deviceLimitsOf without options): the per-AIB
//     slider maxes (A750: LE 228 / ASRock 216 / Acer 216 - the probe
//     verdict; the 235 BiFrost documented row is refuted as a stock value
//     on the Acer card, the DriverStore props max 216 and the DriverStore
//     path refuses 228+ with 0x44000004; A770: LE 228) + the TL 90 C caps
//     + the A770 volt pin / A750 volt unclamp;
//   - ADVANCED ({ advanced: true }): the per-CARD KMD ceilings - the
//     advanced ceiling is a KMD-level clamp, AIB-independent (A770 375 W -
//     M21: the sysman-primary ceiling, the live-verified 2026-08-15 pair
//     write; A750 270 W - the 2026-08-12
//     app-path probe: 250 AND 270 W applied via the bundled 2023 runtime
//     + V1 mW setters, 280+ refused 0x44000004 - the KMD ceiling, NOT in
//     any public source, documented as the app's evidence). The A770
//     advanced TL 115 is RESTORED (the M17c row cap at 90 is removed -
//     the 115 lives on the extended 2023-runtime path; the driver props
//     already cap the stock at 90); the A750 advanced shape pins
//     tempLimitC max 115 (the 2026-08-12 probe: 100 AND 115 C applied via
//     the app path, the KMD ceiling class the same as the A770's 115 - the
//     (90,115] gap on the A750 is closed BY EVIDENCE, not by a pin).
//
// THE NO-MATCH PATH RETURNS THE DEFAULT ROW (round-1 S3): an unlisted card
// keeps today's behavior exactly - { powerLimitW: { max: 252 }, tempLimitC:
// { max: 90 } } stock / { 315 / 115 } extended (two shapes - the caller asks
// for stock or extended via defaultLimitsOf). That default row feeds the
// extended-confirm threshold + ocModeRefusal's thresholds; the LISTED rows
// carry the documented PL AND TL ceilings (round-3 N3 - PL-only was an
// accidental gap: on a listed card whose driver reports an extended TL >
// the documented ceiling, the table caps it so (90, 115] is never offered
// on the A750; the A770's 115 IS offered - the restored KMD ceiling).
//
// The table keys on pciDeviceId FIRST, then the AIB fields for the per-AIB
// PL rows. All table values carry a source comment (oc-corner / SkatterBencher
// / Intel Community / M15 live probe / app-evidence). Driver props stay the
// runtime authority (what IGS reads); this table only pins what is DOCUMENTED.

export interface DeviceLimitsInput {
  /** The device's PCI device id (the caps pciDeviceId field, e.g. '0x000056a0'). */
  pciDeviceId: string | null | undefined;
  /** The decoded AIB vendor (pure/aib.ts), e.g. 'ASRock' / 'Intel (Limited Edition)'. */
  aibVendor: string | null | undefined;
  /** The decoded AIB model, e.g. 'Phantom Gaming'. */
  aibModel: string | null | undefined;
}

/** M17d: the shape selector - `advanced: true` returns the ADVANCED
 *  (KMD-ceiling) shape, the default/falsy the STOCK (per-AIB) shape. */
export interface DeviceLimitsOptions {
  advanced?: boolean;
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
  /** M17c (A750): a DOCUMENTATION MARKER - NOT a consumer hook. It records
   *  the row's intent: this card deliberately carries NO volt max, so the
   *  driver's own voltage props pass through (the A750's 0.288 - the
   *  2026-08-12 probe: props max 0.288 V step 0.005 units V). The finalize
   *  loops (igcl-backend.js / mock-backend.js) read only max/step - the
   *  pass-through works by the ABSENCE of a max (the M17c global 0.234 V
   *  clamp was removed), not by this flag. It exists so a reader can tell
   *  "deliberately unclamped" from "row forgotten". */
  unclamp?: boolean;
}

/** One device row of the table (the STOCK or the ADVANCED shape - the
 *  caller selects via DeviceLimitsOptions). */
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

/** The Arc A770 (pciDeviceId 0x56A0 - the dev-box card) STOCK shape:
 *  - gpuVoltOffsetV max 0.234: the M15 live probe (2026-08-11,
 *    pipeline/live-volt-max-probe.mjs, this machine): 0.235 refused with
 *    0x44000002 on the current driver (32.0.101.8864) - the pin becomes
 *    A770-scoped (other V-unit cards keep their driver props);
 *  - PL 228: oc-corner A750 guide + SkatterBencher #64 (A770 LE) - the
 *    Intel (Limited Edition) ceiling;
 *  - TL 90: oc-corner / SkatterBencher (the documented 90 C TL max). */
const A770_ROW_STOCK: DeviceLimits = {
  listed: true,
  gpuVoltOffsetV: { max: 0.234, step: 0.001 }, // M15 live probe (this box, 2026-08-11); the step 0.001 rides with the max - the driver's 0.005 step puts 0.234 OFF-GRID (a main-side clampSettings snap would turn 0.234 into 0.235 and get refused)
  tempLimitC: { max: 90 }, // oc-corner / SkatterBencher
};

/** The Arc A770 ADVANCED shape (M17d): the KMD-ceiling class, AIB-
 *  independent - PL 375 W (M21: the exposed ceiling rose from 315 to 375 -
 *  the sysman pair accepts + stores PL1=PL2 up to 4095 W (live-verified
 *  2026-08-15), so the >315 W range applies through the sysman companion
 *  as the PRIMARY write; the V1 write range stays 315) + the TL 115 C
 *  RESTORED (docs/igcl-integration.md 8c: 125->115 KMD clamp, 100/110
 *  persist - the app-verified ceiling; the M17c row cap at 90 is REMOVED,
 *  the 115 lives on the extended 2023-runtime path, the driver props cap
 *  the stock at 90). The volt pin rides both shapes (mode-independent). */
const A770_ROW_ADVANCED: DeviceLimits = {
  listed: true,
  gpuVoltOffsetV: { max: 0.234, step: 0.001 }, // M15 live probe (mode-independent)
  powerLimitW: { max: 375 }, // M21: the sysman-primary ceiling (live-verified 2026-08-15); the M3-C-D 315 probe (2026-08-06) pinned the V1 WRITE range
  tempLimitC: { max: 115 }, // docs/igcl-integration.md 8c (125->115 KMD clamp)
};

/** The Arc A750 (pciDeviceId 0x56A1 - verified from pci-ids.ucw.cz/read/PC/8086:
 *  'DG2 [Arc A750]') STOCK shape:
 *  - gpuVoltOffsetV: NO override - the global 0.234 clamp must NOT apply
 *    (the driver's 0.288 passes through; the 2026-08-12 live probe on the
 *    Acer A750: the props report max 0.288 V step 0.005 units V). Modeled
 *    as the { unclamp: true } documentation marker (no consumer - the
 *    pass-through works by the ABSENCE of a volt max; the M17c global
 *    clamp is gone), pinned by the A750 volt range test;
 *  - PL per AIB: LE 228 (oc-corner A750 guide) / ASRock 216 (Intel
 *    Community - the ASRock A750 Challenger 216 W max, the user's stock
 *    card) / Acer 216 (the 2026-08-12 live probe verdict: the DriverStore
 *    props max 216 and the DriverStore path refuses 228/235/250 with
 *    0x44000004 - the BiFrost 235 W documented row (Reddit/overclock.net)
 *    is REFUTED as a stock value on this card/driver). There is NO
 *    model-match fallback (aibOf returns null on an unknown subsys vendor
 *    and caps.aibModel comes from that decode - a vendor-unknown card
 *    carries aibModel null, so a model row could never fire; the M17c-era
 *    /bifrost|predator/i row is REMOVED as dead code - the real BiFrost
 *    card is the live-pinned 0x1025:0xB102 pair -> vendor 'Acer' -> the
 *    216 row). An UNKNOWN AIB gets no PL override - the driver props stay
 *    the runtime authority (no documented ceiling to claim);
 *  - TL 90: oc-corner (the documented A750 TL max). */
const A750_ROW_STOCK: DeviceLimits = {
  listed: true,
  // M17g (the global 0.001 V step - the user's fix): the A750 STOCK row
  // gains the 0.001 STEP beside the unclamp marker - the driver's 0.005
  // grid puts the real 0.288 ceiling OFF-GRID on EVERY V-unit card (the
  // same off-grid hazard the M15 A770 pin fixed). The driver max 0.288
  // stays the pass-through (the unclamp flag stays a DOCUMENTATION
  // MARKER, no consumer - the pass-through works by the ABSENCE of a
  // volt max).
  gpuVoltOffsetV: { unclamp: true, step: 0.001 },
  tempLimitC: { max: 90 }, // oc-corner
};

/** The Arc A750 ADVANCED shape (M17d): the KMD-ceiling class - PL 270 W
 *  (the 2026-08-12 app-path probe on the Acer A750: 250 AND 270 W applied
 *  via the bundled 2023 runtime + V1 mW setters, 280+ refused 0x44000004 -
 *  the KMD-ceiling mechanism the A770's 315 W lives on; NOT in any public
 *  source - documented as the app's evidence) + the TL 115 C (the same
 *  probe: 100 AND 115 C applied via the app path - the KMD ceiling class
 *  is the A770's 115; the M17c 90 pin is REMOVED BY EVIDENCE, the
 *  (90,115] gap on the A750 is closed). The volt unclamp rides both shapes
 *  (mode-independent; the driver's 0.288 passes through). */
const A750_ROW_ADVANCED: DeviceLimits = {
  listed: true,
  // M17g (the global 0.001 V step): the ADVANCED row rides the same step
  // pin as the STOCK row - the mode never changes the voltage grid.
  gpuVoltOffsetV: { unclamp: true, step: 0.001 }, // A750: the driver's 0.288 passes through (the 2026-08-12 probe) - the unclamp flag is a DOCUMENTATION MARKER, no consumer (see ControlLimit)
  powerLimitW: { max: 270 }, // the 2026-08-12 app-path probe (Acer A750): 270 W applied, 280+ refused
  tempLimitC: { max: 115 }, // the 2026-08-12 app-path probe: 100 AND 115 C applied (the A770's 115-class KMD ceiling)
};

/** Resolve the A750 STOCK per-AIB PL ceiling - the documented rows
 *  (oc-corner LE 228, Intel Community ASRock 216) + the live-probe Acer
 *  verdict; null when the AIB is unknown (no documented ceiling to claim;
 *  the driver props stay the authority).
 *  M17d (2026-08-12 probe verdict): the 'Acer' VENDOR match -> 216 - the
 *  DriverStore props on the live Acer A750 (0x1025:0xB102) max at 216 W
 *  and the DriverStore path refuses 228/235/250 with 0x44000004, so the
 *  stock ceiling is the driver-props 216 (the 235 W BiFrost Turbo
 *  documented row - Reddit/overclock.net - is REFUTED as a stock value on
 *  this card/driver). There is NO model-match fallback: aibOf (pure/aib.ts)
 *  returns null on an unknown subsys vendor and caps.aibModel comes from
 *  that decode - a vendor-unknown card carries aibModel null, so a
 *  /bifrost|predator/i row could never fire (the M17c-era model row was
 *  dead code and is REMOVED; the real BiFrost card is the live-pinned
 *  0x1025:0xB102 pair -> vendor 'Acer' -> the probe-pinned 216 row). */
function a750PlMaxOf(input: DeviceLimitsInput): number | undefined {
  const vendor = typeof input.aibVendor === 'string' ? input.aibVendor : null;
  if (vendor === 'Intel (Limited Edition)') return 228; // oc-corner / SkatterBencher
  if (vendor === 'ASRock') return 216; // Intel Community (the ASRock A750 Challenger)
  if (vendor === 'Acer') return 216; // the 2026-08-12 live probe (the Acer A750 0x1025:0xB102): the DriverStore props max 216 - 228/235/250 refused 0x44000004 (the 235 BiFrost documented row REFUTED as a stock value on this card/driver)
  return undefined;
}

/** Resolve the A770 STOCK per-AIB PL ceiling - ONLY the Intel (Limited
 *  Edition) 228 W row is documented for the A770 (oc-corner /
 *  SkatterBencher); an ASRock/unknown A770 gets no PL override (the driver
 *  props stay the runtime authority - the dev-box ASRock A770 keeps
 *  252/315). */
function a770PlMaxOf(input: DeviceLimitsInput): number | undefined {
  return typeof input.aibVendor === 'string' && input.aibVendor === 'Intel (Limited Edition)'
    ? 228
    : undefined;
}

/** The listed rows keyed on the PCI device id (the canonical '0x0000xxxx'
 *  caps/DeviceInfo rendering). Each factory returns the requested shape:
 *  the STOCK row (with the per-AIB PL ceilings) or the ADVANCED row (the
 *  per-CARD KMD ceilings - AIB-independent by design). */
const LISTED_ROWS: Record<string, (input: DeviceLimitsInput, advanced: boolean) => DeviceLimits> = {
  // The A770: 0x56A0 (the dev-box card - the M15 probe evidence).
  [A770_PCI_DEVICE_ID]: (input, advanced) => {
    if (advanced) return A770_ROW_ADVANCED;
    const pl = a770PlMaxOf(input);
    return {
      ...A770_ROW_STOCK,
      ...(pl !== undefined ? { powerLimitW: { max: pl } } : {}),
    };
  },
  // The A750: 0x56A1 (pci-ids-verified). The STOCK shape carries the
  // AIB-specific PL row (LE 228 / ASRock 216 / Acer 216 - the 2026-08-12
  // probe verdict; an unknown AIB keeps no PL override); the ADVANCED
  // shape is the 270 W KMD ceiling for every AIB (the probe-applied
  // value) + the probe-verified 115 C TL.
  [A750_PCI_DEVICE_ID]: (input, advanced) => {
    if (advanced) return A750_ROW_ADVANCED;
    const pl = a750PlMaxOf(input);
    return {
      ...A750_ROW_STOCK,
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
 * degrade. The row's `listed` flag distinguishes the two (the advanced-
 * ceiling gate: a listed card's advanced ceiling comes from the LISTED
 * row, never the default 315/115 - round-2 S8).
 * M17d: `options.advanced` selects the ADVANCED shape (the per-card KMD
 * ceilings); the default/falsy selects the STOCK shape (the per-AIB maxes)
 * - the round-3-N3 rule FLIPS to "a listed row's advanced ceiling = the
 * app-verified KMD ceiling" (A770 375/115 - the M21 sysman-primary
 * ceiling, A750 270/115 - the A750 TL probe-verified 2026-08-12).
 * @param {DeviceLimitsInput} input the device identity (caps pciDeviceId +
 *   the decoded AIB fields)
 * @param {DeviceLimitsOptions} [options] the shape selector - `advanced`
 *   true for the KMD-ceiling shape (default: the stock shape)
 * @returns {DeviceLimits | null}
 */
export function deviceLimitsOf(input: DeviceLimitsInput | null | undefined, options?: DeviceLimitsOptions): DeviceLimits | null {
  if (!input || typeof input !== 'object') return null;
  const advanced = options?.advanced === true;
  const pciId = typeof input.pciDeviceId === 'string' ? input.pciDeviceId.toLowerCase() : '';
  const rowFactory = pciId.length > 0 ? LISTED_ROWS[pciId] : undefined;
  if (!rowFactory) return defaultLimitsOf(advanced);
  return rowFactory(input, advanced);
}

/**
 * M17c: THE NO-MATCH PATH - the default row (today's pins exactly): an
 * unlisted card keeps the current behavior - 252 W / 90 C stock, 315 W /
 * 115 C extended (the two shapes the plan pins - the caller asks for stock
 * or extended). Never null.
 * M17g (the global 0.001 V step): the default row gains `gpuVoltOffsetV:
 * { step: 0.001 }` with NO max - an UNLISTED V-unit card (A380/A310-class)
 * gets the 0.001 step with its driver maxes (the off-grid hazard at
 * device-limits.ts:118 - the driver's 0.005 grid making the real ceiling
 * unreachable - must NOT reproduce on unlisted cards).
 * @param {boolean} extended true when the extended (2023-runtime) range set
 *   applies
 * @returns {DeviceLimits}
 */
export function defaultLimitsOf(extended: boolean): DeviceLimits {
  return extended
    ? { listed: false, powerLimitW: { max: 315 }, tempLimitC: { max: 115 }, gpuVoltOffsetV: { step: 0.001 } } // M3-C-D: the live-verified 315 W ceiling
    : { listed: false, powerLimitW: { max: 252 }, tempLimitC: { max: 90 }, gpuVoltOffsetV: { step: 0.001 } };
}
