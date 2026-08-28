import { el, clear } from '../dom.ts';

const ROOT_ID = 'modal-root';

/** Arc Power-styled confirmation used before a clip is permanently removed. */
export function showRecordingClipDeleteConfirm(fileName: string): Promise<boolean> {
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
    const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', type: 'button', onClick: () => close(false) });
    const remove = el('button', { class: 'btn btn-danger', text: 'Delete', type: 'button', onClick: () => close(true) });
    root.append(el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal recording-delete-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'recording-delete-title' }, [
        el('span', { class: 'recording-eyebrow', text: 'Clip library' }),
        el('h2', { class: 'modal-title', id: 'recording-delete-title', text: 'Delete clip?' }),
        el('p', { class: 'modal-device recording-delete-file', text: fileName, title: fileName }),
        el('p', { class: 'modal-text', text: 'This removes the saved video from your capture folder. This action cannot be undone.' }),
        el('div', { class: 'modal-actions' }, [cancel, remove]),
      ]),
    ]));
    cancel.focus();
  });
}
