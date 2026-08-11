// Arc Power - warranty-waiver decision logic (pure, DOM-free).
//
// The rule is deliberately trivial and total: an apply must not proceed
// while the device waiver is not accepted - the only way to reach 'accepted'
// is an explicit user decision (the dialog's Accept button). There is no
// auto-accept path in this module or anywhere in product code; auto-accept
// exists only under `allowAutoWaiver` in smoke/test backends. The tests pin
// this by asserting decideApply(false) can never return 'proceed'.

export type ApplyDecision = 'proceed' | 'show-waiver';
export type WaiverDialogResult = 'accepted' | 'cancelled';

/**
 * The single product decision rule for an apply: when the device waiver is
 * not accepted, the apply must stop and the dialog must show. M17: on
 * OC-locked devices (overclockingSupported === false) there is NO waiver to
 * accept - the gate is skipped entirely (the driver's per-control
 * 'unsupported' refusals are the honest floor there).
 */
export function decideApply(waiverAccepted: boolean, required = true): ApplyDecision {
  if (!required) return 'proceed';
  return waiverAccepted ? 'proceed' : 'show-waiver';
}

export interface WaiverTransition {
  state: 'accepted' | 'not-accepted';
  accepted: boolean;
}

/**
 * What the dialog outcome means for the waiver state. Only the user's
 * explicit 'accepted' decision flips the state; 'cancelled' leaves it
 * untouched (and the apply never ran).
 */
export function afterDialog(result: WaiverDialogResult): WaiverTransition {
  if (result === 'accepted') return { state: 'accepted', accepted: true };
  return { state: 'not-accepted', accepted: false };
}
