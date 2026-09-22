import { el } from '../dom.ts';
import type { IntelDriverKind, IntelDriverRelease } from '../pure/intel-driver-updates.ts';
import { api } from '../ipc.ts';

const ROOT_ID = 'modal-root';

export function showIntelDriverUpdateDialog(kind: IntelDriverKind, installed: string, release: IntelDriverRelease): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.replaceChildren();
  const close = () => root.replaceChildren();
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: close });
  const confirm = el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Continue to Intel',
    onClick: async () => {
      confirm.disabled = true;
      try {
        await api.openIntelDriverDownloadPage(kind);
        close();
      }
      catch { confirm.disabled = false; status.textContent = 'Could not open Intel’s driver page. Please try again.'; }
    },
  });
  const status = el('p', { class: 'modal-text intel-driver-dialog-status', role: 'status', 'aria-live': 'polite' });
  root.append(el('div', { class: 'modal-overlay', onClick: (event: MouseEvent) => { if (event.target === event.currentTarget) close(); } }, [
    el('div', { class: 'modal intel-driver-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'intel-driver-dialog-title', 'aria-describedby': 'intel-driver-dialog-description' }, [
      el('h2', { class: 'modal-title', id: 'intel-driver-dialog-title', text: 'Intel Driver Update' }),
      el('p', { class: 'modal-text intel-driver-dialog-question', id: 'intel-driver-dialog-description', text: 'Do you want to Download and Install?' }),
      el('dl', { class: 'intel-driver-dialog-versions' }, [
        el('div', {}, [el('dt', { text: 'Installed version' }), el('dd', { text: installed })]),
        el('div', {}, [el('dt', { text: 'Latest Intel version' }), el('dd', { text: release.version })]),
        ...(release.releaseDate ? [el('div', {}, [el('dt', { text: 'Release date' }), el('dd', { text: release.releaseDate })])] : []),
      ]),
      el('p', { class: 'modal-text intel-driver-dialog-note', text: 'Arc Power does not download or install drivers in the background. Intel’s interactive page and installer handle the download and installation consent. Your PC or OEM may provide a driver tailored for your system.' }),
      status,
      el('div', { class: 'modal-actions' }, [cancel, confirm]),
    ]),
  ]));
  cancel.focus();
}
