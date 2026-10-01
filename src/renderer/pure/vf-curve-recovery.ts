import { isValidNativeVfCurve, shouldCommitVfCurveRefresh } from './vf-curve.ts';
import type { VfCurvePoint } from './vf-curve.ts';
import type { VfCurveRange } from '../types.ts';

/** Page lifetime is independent of the generation of individual driver reads. */
export function vfCurveEditorContextIsCurrent(
  requestedDeviceId: number,
  currentDeviceId: number | null,
  requestedDeviceKey: string | null,
  currentDeviceKey: string | null,
  tuningPageActive: boolean,
  requestedPageGeneration: number,
  currentPageGeneration: number,
): boolean {
  return tuningPageActive && shouldCommitVfCurveRefresh(requestedDeviceId, currentDeviceId,
    requestedDeviceKey, currentDeviceKey, false, requestedPageGeneration, currentPageGeneration);
}

/** Preserve the last readable native table when a background read fails.
 * An absent or malformed sample does not establish that the driver changed. */
export function observeVfCurveSnapshot(
  previous: VfCurvePoint[] | null,
  next: unknown,
  range: VfCurveRange,
  allowUniformVoltageOrigin = false,
): { points: VfCurvePoint[] | null; changed: boolean } {
  if (!Array.isArray(next) || !isValidNativeVfCurve(next, range)) {
    return { points: previous, changed: false };
  }
  // Battlemage's native simplified table can translate its common voltage
  // origin between passive reads. Compare native integer-mV spacing while
  // retaining exact frequencies; do not alter displayed or submitted points.
  const nativeMillivolts = (points: VfCurvePoint[]): number[] | null => {
    const millivolts = points.map((point) => point.voltageV * 1000);
    return millivolts.every((voltage) => Math.abs(voltage - Math.round(voltage)) < 1e-6)
      ? millivolts.map(Math.round)
      : null;
  };
  const previousMv = previous && allowUniformVoltageOrigin ? nativeMillivolts(previous) : null;
  const nextMv = allowUniformVoltageOrigin ? nativeMillivolts(next) : null;
  const changed = previous !== null && (previous.length !== next.length
    || previous.some((point, index) => point.freqMhz !== next[index]?.freqMhz
      || (previousMv && nextMv
        ? previousMv[index] - previousMv[0] !== nextMv[index] - nextMv[0]
        : point.voltageV !== next[index]?.voltageV)));
  return { points: next.map((point) => ({ ...point })), changed };
}

/** Discard only the editor's pending VF payload; driver state is untouched. */
export function discardVfCurveDraft(applied: VfCurvePoint[]): {
  draft: VfCurvePoint[];
  nativeApplyDraft: null;
} {
  return { draft: applied.map((point) => ({ ...point })), nativeApplyDraft: null };
}

/** Only a verified LIVE result for this editor can clear a stale snapshot. */
export function verifiedVfCurveApplySnapshot(
  succeeded: boolean,
  responseMatchesEditor: boolean,
  readBack: unknown,
  range: VfCurveRange,
): VfCurvePoint[] | null {
  return succeeded && responseMatchesEditor && Array.isArray(readBack)
    && isValidNativeVfCurve(readBack, range)
    ? readBack.map((point) => ({ ...point }))
    : null;
}
