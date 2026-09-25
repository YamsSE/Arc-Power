import { el, clear } from '../dom.ts';

const ROOT_ID = 'modal-root';

/** Confirm removal of a downloaded Intel installer without implying driver uninstall. */
export function showIntelDriverDownloadDeleteConfirm(version: string): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.getElementById(ROOT_ID) ?? (() => {
      const next = el('div', { id: ROOT_ID });
      document.body.append(next);
      return next;
    })();
    clear(root);
    const close = (confirmed: boolean) => {
      clear(root);
      resolve(confirmed);
    };
    const cancel = el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Cancel',
      onClick: () => close(false),
    });
    const remove = el('button', {
      class: 'btn btn-danger', type: 'button', text: 'Delete Downloaded File',
      onClick: () => close(true),
    });
    root.append(el('div', { class: 'modal-overlay' }, [
      el('div', {
        class: 'modal intel-driver-download-delete-dialog',
        role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'intel-driver-download-delete-title',
        'aria-describedby': 'intel-driver-download-delete-description',
      }, [
        el('h2', { class: 'modal-title', id: 'intel-driver-download-delete-title', text: 'Delete downloaded Intel driver file?' }),
        el('p', { class: 'modal-device', text: `Intel Graphics Driver ${version}` }),
        el('p', {
          class: 'modal-text', id: 'intel-driver-download-delete-description',
          text: 'This permanently deletes the downloaded installer file. It does not uninstall the driver currently installed on your PC.',
        }),
        el('div', { class: 'modal-actions' }, [cancel, remove]),
      ]),
    ]));
    cancel.focus();
  });
}
