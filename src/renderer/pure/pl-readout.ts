// Arc Power - M17g the power-limit card read-out formatter (pure, DOM-free;
// unit-tested in test/pl-readout.test.ts).
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
//      session, the enforced burst read is unavailable" fallback. When the
//      V2 companion was REFUSED (the value above the DriverStore ceiling)
//      the note carries the ceilingW and the line appends the honest
//      ceiling sentence (round-1 N4 wording);
//   3. the honest 'PL1 - / PL2 -' - NOTHING was applied in the session AND
//      the sysman is absent.

/** The '(set)' marker text (pinned in the ui-verify - M17g). */
export const PL2_SET_MARKER = '(set)';

/** The refused-ceiling sentence (the round-1 N4 wording, pinned). */
export function pl2CeilingSentence(ceilingW: number): string {
  return `the burst limit (PL2) stays at its CURRENT value - the V2 setter refuses above the driver ceiling (${Math.round(ceilingW)} W) - the sustained limit (PL1) is set`;
}

/**
 * M17g: the power-limit card's read-out line.
 * @param {object | null} limits the sysman read ({ sustainedW, burstW } in
 *   W) - null when the layer is absent
 * @param {{ valueW: number, ceilingW?: number } | undefined} set the
 *   session-tracked last-applied PL2 (fed ONLY from the apply envelope's
 *   pl2Note) - undefined when nothing applied in this session
 * @param {number | null | undefined} enforcedW the IGCL enforced PL1 read
 *   (currentState.powerLimitW - the '(set)' line's PL1 side)
 */
export function formatPlReadout(
  limits: { sustainedW?: number | null; burstW?: number | null } | null | undefined,
  set: { valueW: number; ceilingW?: number } | undefined,
  enforcedW: number | null | undefined,
): string {
  if (limits && Number.isFinite(limits.sustainedW) && Number.isFinite(limits.burstW)) {
    return `PL1 ${Math.round(limits.sustainedW as number)} W / PL2 ${Math.round(limits.burstW as number)} W`;
  }
  if (set && Number.isFinite(set.valueW)) {
    const pl1 = typeof enforcedW === 'number' && Number.isFinite(enforcedW) ? `${Math.round(enforcedW)} W` : '-';
    const base = `PL1 ${pl1} / PL2 ${Math.round(set.valueW)} W ${PL2_SET_MARKER}`;
    if (typeof set.ceilingW === 'number' && Number.isFinite(set.ceilingW)) {
      return `${base} - ${pl2CeilingSentence(set.ceilingW)}`;
    }
    return base;
  }
  return 'PL1 - / PL2 -';
}
