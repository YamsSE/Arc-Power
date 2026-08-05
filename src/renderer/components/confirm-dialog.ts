// Arc Power — M2C-C extended-range confirm modal.
//
// Shown before applying any settings that exceed Intel's standard limits
// (PL > 252 W or TL > 90 C — requiresExtendedRangeConfirm in
// pure/settings.ts): an honest warning that the value goes beyond the
// standard limit, depends on the card/driver, and that the Acer BiFrost
// profile used 300 W. Only the user's explicit Confirm lets the apply
// proceed; Cancel returns false and the caller aborts the apply.

import { el, clear } from '../dom.ts';

const ROOT_ID = 'modal-root';

export const EXTENDED_RANGE_WARNING =
  'This goes beyond Intel\u2019s standard limit for this GPU. Whether the card accepts it depends on the card and the driver (the Acer BiFrost profile used 300 W). Apply anyway?';

export function showExtendedRangeConfirm(deviceName: string): Promise<boolean> {
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
        el('h2', { class: 'modal-title', text: 'Extended power/temperature limit' }),
        el('div', { class: 'modal-device', text: deviceName }),
        el('p', { class: 'modal-text', text: EXTENDED_RANGE_WARNING }),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onClick: () => close(false) }),
          el('button', { class: 'btn btn-danger', text: 'Apply anyway', onClick: () => close(true) }),
        ]),
      ]),
    ]));
  });
}
