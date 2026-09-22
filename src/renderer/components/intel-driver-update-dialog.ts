import { el } from '../dom.ts';
import type { IntelDriverKind, IntelDriverRelease } from '../pure/intel-driver-updates.ts';
import { api } from '../ipc.ts';

const ROOT_ID = 'modal-root';
type DriverDownloadProgress = { kind: IntelDriverKind; version: string; bytesDownloaded: number; totalBytes: number; percent: number };
type DriverDownloadApi = {
  intelDriverDownloadStart(kind: IntelDriverKind, version: string, acceptedIntelLicense: boolean): Promise<{ downloaded: true; sizeBytes: number }>;
  intelDriverDownloadCancel(kind: IntelDriverKind): Promise<{ cancelled: boolean }>;
  intelDriverInstall(kind: IntelDriverKind, version: string): Promise<{ launched: true }>;
  onIntelDriverDownloadProgress(listener: (progress: DriverDownloadProgress) => void): () => void;
  openIntelDriverDownloadPage(kind: IntelDriverKind): Promise<void>;
};
const driverApi = api as typeof api & DriverDownloadApi;

export function showIntelDriverUpdateDialog(
  kind: IntelDriverKind,
  installed: string,
  release: IntelDriverRelease,
  initiallyDownloaded = false,
  onDownloaded: () => void = () => undefined,
): void {
  const root = document.getElementById(ROOT_ID) ?? (() => {
    const created = el('div', { id: ROOT_ID });
    document.body.append(created);
    return created;
  })();
  root.replaceChildren();
  let closed = false;
  let downloading = false;
  let downloaded = initiallyDownloaded;
  let unsubscribe: (() => void) | null = null;
  const status = el('p', { class: 'modal-text intel-driver-dialog-status', role: 'status', 'aria-live': 'polite' });
  const actions = el('div', { class: 'modal-actions intel-driver-dialog-actions' });
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (downloading) {
      downloading = false;
      void driverApi.intelDriverDownloadCancel(kind).catch(() => undefined);
    }
    root.replaceChildren();
  };
  const install = async () => {
    status.textContent = 'Launching Intel’s interactive installer…';
    setButtonsDisabled(true);
    try {
      await driverApi.intelDriverInstall(kind, release.version);
      close();
    } catch {
      status.textContent = 'Could not launch the Intel driver installer. Please try again.';
      setButtonsDisabled(false);
    }
  };
  const setButtonsDisabled = (disabled: boolean) => {
    for (const child of actions.children) {
      if ('disabled' in child) (child as HTMLButtonElement).disabled = disabled;
    }
  };
  const renderReadyActions = () => {
    const later = el('button', { class: 'btn', type: 'button', text: 'Install Later', onClick: close });
    const now = el('button', { class: 'btn btn-primary', type: 'button', text: 'Install Now', onClick: () => void install() });
    actions.replaceChildren(later, now);
    later.focus();
  };
  const downloadedReady = () => {
    downloaded = true;
    downloading = false;
    unsubscribe?.();
    unsubscribe = null;
    onDownloaded();
    status.textContent = 'Driver download verified and ready to install.';
    renderReadyActions();
  };
  const intelPageLink = el('a', {
    class: 'intel-driver-license-link', href: '#intel-driver-page',
    text: 'Review Intel’s official driver page',
    onClick: async (event: MouseEvent) => {
      event.preventDefault();
      try { await driverApi.openIntelDriverDownloadPage(kind); }
      catch { status.textContent = 'Could not open Intel’s driver page. Please try again.'; }
    },
  });

  const license = el('input', { type: 'checkbox', class: 'intel-driver-license-checkbox', 'aria-label': 'I accept Intel’s Software License Agreement' }) as HTMLInputElement;
  const download = el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Download', disabled: true,
    onClick: async () => {
      if (!license.checked || downloading) return;
      downloading = true;
      status.textContent = 'Starting driver download…';
      actions.replaceChildren(el('button', { class: 'btn', type: 'button', text: 'Cancel download', onClick: close }));
      unsubscribe = driverApi.onIntelDriverDownloadProgress((progress) => {
        if (closed || progress.kind !== kind || progress.version !== release.version) return;
        const percent = Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0));
        progressBar.value = percent;
        progressLabel.textContent = `${Math.round(percent)}%`;
        status.textContent = `Downloading Intel driver… ${Math.round(percent)}%`;
      });
      try {
        await driverApi.intelDriverDownloadStart(kind, release.version, true);
        if (!closed) downloadedReady();
      } catch {
        if (closed) return;
        downloading = false;
        unsubscribe?.();
        unsubscribe = null;
        status.textContent = 'The Intel driver download failed. Please try again.';
        actions.replaceChildren(el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: close }), download);
      }
    },
  }) as HTMLButtonElement;
  license.addEventListener('change', () => { download.disabled = !license.checked || downloaded; });
  const progressBar = el('progress', { class: 'intel-driver-progress', max: 100, value: 0, 'aria-label': 'Driver download progress' }) as HTMLProgressElement;
  const progressLabel = el('span', { class: 'intel-driver-progress-label', text: '0%' });
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: close });
  if (downloaded) {
    status.textContent = 'Driver download verified and ready to install.';
    renderReadyActions();
  } else actions.append(cancel, download);

  root.append(el('div', { class: 'modal-overlay', onClick: (event: MouseEvent) => { if (event.target === event.currentTarget) close(); } }, [
    el('div', { class: 'modal intel-driver-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'intel-driver-dialog-title', 'aria-describedby': 'intel-driver-dialog-description' }, [
      el('h2', { class: 'modal-title', id: 'intel-driver-dialog-title', text: 'Intel Driver Update' }),
      el('p', { class: 'modal-text intel-driver-dialog-question', id: 'intel-driver-dialog-description', text: 'Review and download the Intel driver update.' }),
      el('dl', { class: 'intel-driver-dialog-versions' }, [
        el('div', {}, [el('dt', { text: 'Installed version' }), el('dd', { text: installed })]),
        el('div', {}, [el('dt', { text: 'Latest Intel version' }), el('dd', { text: release.version })]),
        ...(release.releaseDate ? [el('div', {}, [el('dt', { text: 'Release date' }), el('dd', { text: release.releaseDate })])] : []),
      ]),
      intelPageLink,
      el('label', { class: 'intel-driver-license-label' }, [license, ' I accept Intel’s Software License Agreement']),
      el('div', { class: 'intel-driver-progress-row' }, [progressBar, progressLabel]),
      el('p', { class: 'modal-text intel-driver-dialog-note', text: 'Your PC manufacturer (OEM) may provide a driver tailored for your system. Driver installation is interactive; Arc Power will not install silently.' }),
      status,
      actions,
    ]),
  ]));
  if (downloaded) return;
  cancel.focus();
}
