// Arc Power - M17g/M17n the power-limit card read-out formatter (pure,
// DOM-free; unit-tested in test/pl-readout.test.ts).
//
// The Tuning PL card shows one line: the PL1 (IGCL enforced) + PL2
// (burst) read-out. The sources, in order of precedence:
//   1. the SYSMAN read ({ sustainedW, burstW } in W) - the burst domain is
//      invisible to IGCL, so the Level Zero Sysman layer is the read-out's
//      real source when it answers ('PL1 210 W / PL2 210 W');
//   2. the SESSION-TRACKED '(set)' value - the last-applied PL2 from the
//      apply envelope's pl2Note (the per-device session state fed ONLY
//      from that envelope; the boot one-shot + the profile/tray applies
//      never feed it - they show the sysman read or '-'). The '(set)'
//      marker is the pinned text for the honest "the value was SET in this
//      session, the enforced burst read is unavailable" fallback. M17n
//      (round-1 S1): the entry carries the LANDED FLAG + the sentence
//      BRANCHES on it:
//        - THE CLAMP CLASS (landed + ceilingW): the V2-CLAMP landed - the
//          VALUE-ACCURATE sentence keyed on the landed valueW ('the burst
//          limit (PL2) is set to <valueW> W via the driverstore fallback -
//          the sysman layer was not ready - the sustained limit (PL1) is
//          set', with '= the driver ceiling (<ceiling> W)' when the landed
//          value IS the ceiling);
//        - THE REFUSED CLASS (landed false + ceilingW) keeps the existing
//          sentence (the V2 setter refused above the DriverStore ceiling -
//          the round-1 N4 wording);
//        - landed false WITHOUT a ceiling: the honest no-claim ('PL1 - /
//          PL2 -' - a failed write never claims a value);
//   3. the honest 'PL1 - / PL2 -' - NOTHING was applied in the session AND
//      the sysman is absent.

/** The '(set)' marker text (pinned in the ui-verify - M17g). */
export const PL2_SET_MARKER = '(set)';

/** The refused-ceiling sentence (the round-1 N4 wording, pinned). */
export function pl2CeilingSentence(ceilingW: number): string {
  return `the burst limit (PL2) stays at its CURRENT value - the V2 setter refuses above the driver ceiling (${Math.round(ceilingW)} W) - the sustained limit (PL1) is set`;
}

/**
 * M17n (round-1 S1): THE VALUE-ACCURATE CLAMP SENTENCE - the V2-clamp
 * landed PL2 = valueW (the driverstore fallback, the sysman layer was not
 * ready). When the landed value IS the driver ceiling, the sentence names
 * the equality (the user's original 'PL2 goes to 252W which is the driver
 * Max' observation). The wording is pinned in the unit tests (the clamp
 * path is exercised by the apply-routing suite - no ui-verify variant
 * drives the not-ready helper).
 * M17o (N10): when the landed value is BELOW the requested burst
 * (valueW < requestedW), the sentence appends THE PROMISE - 'it will be
 * raised to <requestedW> W automatically when the sysman layer finishes
 * initializing' (the auto-upgrade intent flow: the not-ready apply's
 * intent lands the exact value when the helper's ze init closes the
 * window). NO promise when the clamp already landed the full request
 * (valueW === requestedW) - there is nothing left to raise to.
 */
export function pl2ClampSentence(valueW: number, ceilingW: number, requestedW?: number): string {
  const v = Math.round(valueW);
  const c = Math.round(ceilingW);
  const eq = v === c ? ` = the driver ceiling (${c} W)` : '';
  const promise = typeof requestedW === 'number' && Number.isFinite(requestedW) && v < Math.round(requestedW)
    ? ` - it will be raised to ${Math.round(requestedW)} W automatically when the sysman layer finishes initializing`
    : '';
  return `the burst limit (PL2) is set to ${v} W${eq} via the driverstore fallback - the sysman layer was not ready - the sustained limit (PL1) is set${promise}`;
}

/**
 * M17g/M17n: the power-limit card's read-out line.
 * @param {object | null} limits the sysman read ({ sustainedW, burstW } in
 *   W) - null when the layer is absent
 * @param {{ landed?: boolean, valueW: number, ceilingW?: number, requestedW?: number } | undefined} set the
 *   session-tracked last-applied PL2 (fed ONLY from the apply envelope's
 *   pl2Note - the M17n landed flag branches the sentence; M17o the
 *   requestedW drives the promise clause) - undefined when
 *   nothing applied in this session
 * @param {number | null | undefined} enforcedW the IGCL enforced PL1 read
 *   (currentState.powerLimitW - the '(set)' line's PL1 side)
 */
export function formatPlReadout(
  limits: { sustainedW?: number | null; burstW?: number | null } | null | undefined,
  set: { landed?: boolean; valueW: number; ceilingW?: number; requestedW?: number } | undefined,
  enforcedW: number | null | undefined,
): string {
  if (limits && Number.isFinite(limits.sustainedW) && Number.isFinite(limits.burstW)) {
    return `PL1 ${Math.round(limits.sustainedW as number)} W / PL2 ${Math.round(limits.burstW as number)} W`;
  }
  if (set && Number.isFinite(set.valueW)) {
    const pl1 = typeof enforcedW === 'number' && Number.isFinite(enforcedW) ? `${Math.round(enforcedW)} W` : '-';
    const base = `PL1 ${pl1} / PL2 ${Math.round(set.valueW)} W ${PL2_SET_MARKER}`;
    const ceilingW = typeof set.ceilingW === 'number' && Number.isFinite(set.ceilingW) ? set.ceilingW : null;
    if (set.landed === true && ceilingW !== null) {
      // THE CLAMP CLASS (M17n round-1 S1): the value-accurate sentence -
      // the clamp class NEVER renders the refused sentence. M17o: the
      // promise clause rides when valueW < requestedW.
      return `${base} - ${pl2ClampSentence(set.valueW, ceilingW, set.requestedW)}`;
    }
    if (set.landed !== true && ceilingW !== null) {
      // THE REFUSED CLASS (kept - the M17g round-1 N4 wording; the M17g
      // legacy shape without the landed flag renders the same sentence).
      return `${base} - ${pl2CeilingSentence(ceilingW)}`;
    }
    if (set.landed === false) {
      // The honest no-claim: the write did not land and no ceiling is
      // known - a failed write never claims a value ('PL2 stayed').
      return 'PL1 - / PL2 -';
    }
    return base;
  }
  return 'PL1 - / PL2 -';
}
