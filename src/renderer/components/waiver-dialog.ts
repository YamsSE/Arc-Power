// Arc Power — warranty-waiver modal. Shown before the first OC apply while
// the device waiver is not accepted, AND at every startup as the boot
// reminder (M4-B, user: "please prompt it when the Program opens" — the
// driver exposes no waiver getter, so the dialog at open is the only
// reliable visibility). Only the user's explicit Accept resolves to
// 'accepted'; the caller then calls waiver-accept over IPC and proceeds. An
// already-accepted session sees the dialog in its ACCEPTED state (a single
// OK — a reminder, never a re-accept). There is no auto-accept anywhere in
// this module.

import { el, clear } from '../dom.ts';
import { api } from '../ipc.ts';
import { decideApply } from '../pure/waiver.ts';
import type { WaiverDialogResult } from '../pure/waiver.ts';
import { toast } from './toast.ts';

const ROOT_ID = 'modal-root';

const WAIVER_TEXT =
  'Overclocking can damage your GPU, cause system instability, crashes, or data loss, and void your warranty. ' +
  'Intel Graphics Software and Arc Power make no guarantee of stability at raised clock, voltage, or power limits. ' +
  'You are proceeding at your own risk.';

/**
 * Show the warranty-waiver modal. Defaults to the classic Cancel/Accept pair
 * (only an explicit Accept resolves to 'accepted'). With `alreadyAccepted`
 * the dialog renders in its ACCEPTED state — the same title/text plus a
 * green "Status: Accepted" line and a single OK button (closes with
 * 'accepted'); it is a reminder, never a re-accept and never an auto-accept.
 */
export function showWaiverDialog(deviceName: string, opts?: { alreadyAccepted?: boolean }): Promise<WaiverDialogResult> {
  const alreadyAccepted = opts?.alreadyAccepted === true;
  return new Promise((resolve) => {
    const root = document.getElementById(ROOT_ID) ?? (() => {
      const r = el('div', { id: ROOT_ID });
      document.body.append(r);
      return r;
    })();
    clear(root);

    const close = (result: WaiverDialogResult) => {
      clear(root);
      resolve(result);
    };

    const actions = alreadyAccepted
      ? [el('button', { class: 'btn btn-primary', text: 'OK', onClick: () => close('accepted') })]
      : [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close('cancelled') }),
          el('button', { class: 'btn btn-danger', text: 'Accept', onClick: () => close('accepted') }),
        ];

    const overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h2', { class: 'modal-title', text: 'Warranty waiver' }),
        el('div', { class: 'modal-device', text: deviceName }),
        el('p', { class: 'modal-text', text: WAIVER_TEXT }),
        ...(alreadyAccepted
          ? [el('div', { class: 'modal-status', text: 'Status: Accepted' })]
          : []),
        el('div', { class: 'modal-actions' }, actions),
      ]),
    ]);
    root.append(overlay);
  });
}

/**
 * M4-B: the boot waiver prompt — shows on EVERY startup. An in-session
 * ACCEPTED waiver renders the dialog in its accepted state (single OK, NO
 * waiver-accept IPC) and returns 'accepted' immediately; an unaccepted
 * session shows the classic Cancel/Accept pair and an explicit Accept
 * persists via IPC (a persistence failure toasts and returns 'cancelled' —
 * same pattern as ensureWaiver). Never auto-accepts.
 */
export async function promptWaiverAtBoot(deviceId: number, waiverAccepted: boolean, deviceName: string): Promise<WaiverDialogResult> {
  const alreadyAccepted = waiverAccepted === true;
  const decision = await showWaiverDialog(deviceName, { alreadyAccepted });
  if (alreadyAccepted) return 'accepted'; // reminder only — NO waiver-accept IPC
  if (decision === 'cancelled') return 'cancelled';
  try {
    await api.waiverAccept(deviceId);
    // `decision` was already 'accepted' when we got here — the persisted
    // acceptance is the only thing left to do.
    return 'accepted';
  } catch (err) {
    toast('error', 'Waiver could not be saved', err instanceof Error ? err.message : String(err));
    return 'cancelled';
  }
}

/**
 * Product apply gate: when the device waiver is not accepted, show the
 * dialog; on explicit Accept, persist acceptance (backend + ProfileStore via
 * IPC) and return 'accepted'. Returns 'cancelled' when the user declined or
 * the acceptance could not be saved.
 */
export async function ensureWaiver(deviceId: number, waiverAccepted: boolean, deviceName: string): Promise<WaiverDialogResult> {
  if (decideApply(waiverAccepted) === 'proceed') return 'accepted';
  const decision = await showWaiverDialog(deviceName);
  if (decision === 'cancelled') return 'cancelled';
  try {
    await api.waiverAccept(deviceId);
    // `decision` was already 'accepted' when we got here — the persisted
    // acceptance is the only thing left to do.
    return 'accepted';
  } catch (err) {
    toast('error', 'Waiver could not be saved', err instanceof Error ? err.message : String(err));
    return 'cancelled';
  }
}
