// Arc Power - M3-C-D/M3-C-E Advanced OC Mode enable confirm modal.
//
// Shown once when the user switches the OC mode from Stock to Advanced on
// the Overclocking tab: the honest beyond-Intel-specs disclaimer. Only the
// user's explicit confirm enables the mode; Cancel keeps stock mode.
//
// M3-C-D (double-dialog decision): the PER-APPLY extended-range confirm is
// GONE from every apply path (OC tab, Profiles page, tray) - in Advanced
// mode this mode-enable confirm already warned; in Stock mode the shared
// oc-mode gate refuses extended values with a toast/balloon, never a
// dead-end confirm dialog.

import { el, clear } from '../dom.ts';

const ROOT_ID = 'modal-root';

export const ADVANCED_MODE_WARNING =
  'Advanced OC Mode exposes power and temperature limits beyond Intel\u2019s standard limit. Whether the card accepts them depends on the card, the driver and the power supply (the Acer BiFrost profile used 300 W). Enable Advanced OC Mode?';

export function showAdvancedModeConfirm(deviceName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById(ROOT_ID) ?? (() => {
      const r = el('div', { id: ROOT_ID });
      document.body.append(r);
      return r;
    })();
    clear(root);

    const close = (yes: boolean) => {
      clear(root);
      resolve(yes);
    };

    root.append(el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
        el('h2', { class: 'modal-title', text: 'Advanced OC Mode' }),
        el('div', { class: 'modal-device', text: deviceName }),
        el('p', { class: 'modal-text', text: ADVANCED_MODE_WARNING }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close(false) }),
          el('button', { class: 'btn btn-danger', text: 'Enable Advanced OC Mode', onClick: () => close(true) }),
        ]),
      ]),
    ]));
  });
}
