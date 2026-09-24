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
  openIntelDriverDownloadPage(kind: IntelDriverKind, version: string): Promise<void>;
};
const driverApi = api as typeof api & DriverDownloadApi;

export function confirmIntelDriverInstall(): Promise<boolean> {
  const root = document.getElementById(ROOT_ID) ?? (() => {
    const created = el('div', { id: ROOT_ID });
    document.body.append(created);
    return created;
  })();
  root.replaceChildren();
  return new Promise((resolve) => {
    let settled = false;
    let overlay: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      observer = null;
      if (overlay && root.contains(overlay)) root.replaceChildren();
      resolve(confirmed);
    };
    const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => finish(false) });
    const install = el('button', { class: 'btn btn-primary', type: 'button', text: 'Install Driver', onClick: () => finish(true) });
    const confirmationOverlay = el('div', { class: 'modal-overlay' }, [
      el('div', { class: 'modal intel-driver-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'intel-driver-install-confirm-title', 'aria-describedby': 'intel-driver-install-confirm-description' }, [
        el('h2', { class: 'modal-title', id: 'intel-driver-install-confirm-title', text: 'Install Intel Driver?' }),
        el('p', { class: 'modal-text', id: 'intel-driver-install-confirm-description', text: 'The Intel interactive installer will open. Arc Power will close after it launches.' }),
        el('div', { class: 'modal-actions intel-driver-dialog-actions' }, [cancel, install]),
      ]),
    ]);
    overlay = confirmationOverlay;
    root.append(confirmationOverlay);
    observer = new MutationObserver((records) => {
      if (records.some((record) => Array.from(record.removedNodes).includes(confirmationOverlay))) finish(false);
    });
    observer.observe(root, { childList: true });
    cancel.focus();
  });
}

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
  const downloadPanel = el('section', { class: 'intel-driver-tab-panel', id: 'intel-driver-download-panel', role: 'tabpanel', 'aria-labelledby': 'intel-driver-download-tab' });
  const changelogPanel = el('section', { class: 'intel-driver-tab-panel', id: 'intel-driver-changelog-panel', role: 'tabpanel', 'aria-labelledby': 'intel-driver-changelog-tab', hidden: true });
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
      try { await driverApi.openIntelDriverDownloadPage(kind, release.version); }
      catch { status.textContent = 'Could not open Intel’s driver page. Please try again.'; }
    },
  });

  const downloadTab = el('button', {
    class: 'intel-driver-tab is-active', id: 'intel-driver-download-tab', type: 'button', role: 'tab',
    'aria-controls': 'intel-driver-download-panel', 'aria-selected': 'true', tabindex: 0, text: 'Download',
  });
  const changelogTab = el('button', {
    class: 'intel-driver-tab', id: 'intel-driver-changelog-tab', type: 'button', role: 'tab',
    'aria-controls': 'intel-driver-changelog-panel', 'aria-selected': 'false', tabindex: -1, text: 'Changelog',
  });
  const selectTab = (showChangelog: boolean, moveFocus = false) => {
    downloadTab.setAttribute('aria-selected', String(!showChangelog));
    downloadTab.setAttribute('tabindex', showChangelog ? '-1' : '0');
    downloadTab.classList.toggle('is-active', !showChangelog);
    changelogTab.setAttribute('aria-selected', String(showChangelog));
    changelogTab.setAttribute('tabindex', showChangelog ? '0' : '-1');
    changelogTab.classList.toggle('is-active', showChangelog);
    downloadPanel.hidden = showChangelog;
    changelogPanel.hidden = !showChangelog;
    if (moveFocus) (showChangelog ? changelogTab : downloadTab).focus();
  };
  const handleTabKeydown = (event: KeyboardEvent) => {
    let showChangelog: boolean;
    switch (event.key) {
      case 'ArrowRight': showChangelog = event.currentTarget === downloadTab; break;
      case 'ArrowLeft': showChangelog = event.currentTarget === downloadTab; break;
      case 'Home': showChangelog = false; break;
      case 'End': showChangelog = true; break;
      default: return;
    }
    event.preventDefault();
    selectTab(showChangelog, true);
  };
  downloadTab.addEventListener('click', () => selectTab(false));
  changelogTab.addEventListener('click', () => selectTab(true));
  downloadTab.addEventListener('keydown', handleTabKeydown);
  changelogTab.addEventListener('keydown', handleTabKeydown);
  changelogPanel.append(release.changelog.length
    ? el('ul', { class: 'intel-driver-changelog-list' }, release.changelog.map((item) => el('li', { text: item })))
    : el('p', { class: 'modal-text intel-driver-changelog-empty', text: 'No release highlights are available.' }));

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

  root.append(el('div', { class: 'modal-overlay' }, [
    el('div', { class: 'modal intel-driver-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'intel-driver-dialog-title', 'aria-describedby': 'intel-driver-dialog-description' }, [
      el('h2', { class: 'modal-title', id: 'intel-driver-dialog-title', text: 'Intel Driver Update' }),
      el('p', { class: 'modal-text intel-driver-dialog-question', id: 'intel-driver-dialog-description', text: 'Review and download the Intel driver update.' }),
      el('dl', { class: 'intel-driver-dialog-versions' }, [
        el('div', {}, [el('dt', { text: 'Installed version' }), el('dd', { text: installed })]),
        el('div', {}, [el('dt', { text: 'Selected Intel version' }), el('dd', { text: release.version })]),
        ...(release.releaseDate ? [el('div', {}, [el('dt', { text: 'Release date' }), el('dd', { text: release.releaseDate })])] : []),
        ...(release.sizeBytes ? [el('div', {}, [el('dt', { text: 'Package size' }), el('dd', { text: formatDriverSize(release.sizeBytes) })])] : []),
      ]),
      el('div', { class: 'intel-driver-tabs', role: 'tablist', 'aria-label': 'Intel driver details' }, [downloadTab, changelogTab]),
      downloadPanel,
      changelogPanel,
    ]),
  ]));
  downloadPanel.append(
    intelPageLink,
    el('label', { class: 'intel-driver-license-label' }, [license, ' I accept Intel’s Software License Agreement']),
    el('div', { class: 'intel-driver-progress-row' }, [progressBar, progressLabel]),
    el('p', { class: 'modal-text intel-driver-dialog-note', text: 'Your PC manufacturer (OEM) may provide a driver tailored for your system. Driver installation is interactive; Arc Power will not install silently.' }),
    status,
    actions,
  );
  if (downloaded) return;
  cancel.focus();
}

function formatDriverSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / (1024 ** 3)).toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}
