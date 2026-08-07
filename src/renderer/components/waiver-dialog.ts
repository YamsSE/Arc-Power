// Arc Power — warranty-waiver modal. Shown before the first OC apply while
// the device waiver is not accepted, AND at every startup while the waiver
// is NOT accepted (M4-B, user: "please prompt it when the Program opens" —
// the driver exposes no waiver getter, so the dialog at open is the only
// reliable visibility). M4-D (user, PERMANENT acceptance): a PERSISTED
// acceptance is the user's permanent consent — the boot prompt is SKIPPED
// entirely then (the accepted-state reminder dialog is REMOVED; the
// dashboard health row remains the status display), and an apply-time
// waiver-not-set with an accepted store is silently re-set + retried in
// main. This module is the classic Cancel/Accept dialog only. There is no
// auto-accept anywhere in this module.

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
 * Show the warranty-waiver modal — the classic Cancel/Accept pair (only an
 * explicit Accept resolves to 'accepted'). M4-D: the accepted-state
 * reminder variant is REMOVED (a persisted acceptance skips the prompt
 * entirely — the boot flow only calls this for unaccepted sessions).
 */
export function showWaiverDialog(deviceName: string): Promise<WaiverDialogResult> {
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

    const overlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h2', { class: 'modal-title', text: 'Warranty waiver' }),
        el('div', { class: 'modal-device', text: deviceName }),
        el('p', { class: 'modal-text', text: WAIVER_TEXT }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close('cancelled') }),
          el('button', { class: 'btn btn-danger', text: 'Accept', onClick: () => close('accepted') }),
        ]),
      ]),
    ]);
    root.append(overlay);
  });
}

/**
 * M4-B/M4-D: the boot waiver prompt — shown ONLY while the waiver is not
 * accepted (the CALLER decides — app.ts fires it only when
 * caps.waiverAccepted !== true; a persisted acceptance is the user's
 * permanent consent and the app never asks again). Classic Cancel/Accept
 * pair; an explicit Accept persists via IPC (a persistence failure toasts
 * and returns 'cancelled' — same pattern as ensureWaiver). Never
 * auto-accepts. Non-blocking by construction: the caller runs it detached
 * from the boot sequence.
 */
export async function promptWaiverAtBoot(deviceId: number, deviceName: string): Promise<WaiverDialogResult> {
  const decision = await showWaiverDialog(deviceName);
  if (decision === 'cancelled') return 'cancelled';
  try {
    await api.waiverAccept(deviceId);
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
