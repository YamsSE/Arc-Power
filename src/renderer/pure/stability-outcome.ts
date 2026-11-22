export const STABILITY_CADENCE_DEFAULT_MS = 600;

export type StabilityDialogOutcome =
  | 'passed'
  | 'warning'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'unavailable'
  | 'no-workload';

export function stabilityDialogOutcome(
  outcome: string | null | undefined,
  sampleCount: number,
  thresholdBreaches: number,
): StabilityDialogOutcome {
  switch (outcome) {
    case 'passed':
    case 'warning':
    case 'failed':
    case 'aborted':
    case 'cancelled':
    case 'unavailable':
    case 'no-workload':
      return outcome;
    case 'completed':
      if (sampleCount <= 0) return 'unavailable';
      return thresholdBreaches > 0 ? 'warning' : 'passed';
    default:
      if (sampleCount <= 0) return 'unavailable';
      return thresholdBreaches > 0 ? 'warning' : 'passed';
  }
}
