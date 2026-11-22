// Frameless window controls and updater flow. The title bar carries the app
// name and window actions; app.ts places the updater control beside the
// version in the sidebar footer.

import { api } from '../ipc.ts';
import { toast } from './toast.ts';

const MAX_BTN_SEL = '.window-btn[data-op="maximize-toggle"]';

/** Update button states. */
type UpdateState = 'idle' | 'checking' | 'update-available' | 'downloading' | 'downloaded' | 'error';

let updateState: UpdateState = 'idle';
let updateInfo: { version: string; assetUrl: string; assetName: string; assetSize?: number | null } | null = null;
let downloadReceipt: string | null = null;
let downloadPercent = 0;
let downloadedBytes = 0;

function setUpdateBtn(state: UpdateState): void {
  updateState = state;
  const btn = document.getElementById('titlebar-update-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const iconCheck = btn.querySelector('.icon-update-check');
  const iconDownload = btn.querySelector('.icon-update-download');
  const iconDone = btn.querySelector('.icon-update-done');
  if (!iconCheck || !iconDownload || !iconDone) return;

  // Hide all icons first
  (iconCheck as HTMLElement).style.display = 'none';
  (iconDownload as HTMLElement).style.display = 'none';
  (iconDone as HTMLElement).style.display = 'none';
  btn.classList.remove('update-spinning', 'update-available', 'update-downloading', 'update-error');
  btn.disabled = state === 'checking' || state === 'downloading';

  switch (state) {
    case 'idle':
      btn.style.display = '';
      (iconCheck as HTMLElement).style.display = '';
      btn.title = 'Check for updates';
      btn.setAttribute('aria-label', 'Check for updates');
      break;
    case 'checking':
      btn.style.display = '';
      (iconCheck as HTMLElement).style.display = '';
      btn.classList.add('update-spinning');
      btn.title = 'Checking for updates...';
      btn.setAttribute('aria-label', 'Checking for updates');
      break;
    case 'update-available':
      btn.style.display = '';
      (iconDownload as HTMLElement).style.display = '';
      btn.classList.add('update-available');
      btn.title = `Update available: v${updateInfo?.version ?? '?'} - click to download`;
      btn.setAttribute('aria-label', `Update available: v${updateInfo?.version ?? '?'} - click to download`);
      break;
    case 'downloading':
      btn.style.display = '';
      (iconDownload as HTMLElement).style.display = '';
      btn.classList.add('update-downloading', 'update-spinning');
      {
        const progressText = Number.isFinite(downloadPercent)
          ? `${Math.round(downloadPercent)}%`
          : `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB downloaded`;
        btn.title = `Downloading update... ${progressText}`;
        btn.setAttribute('aria-label', `Downloading update... ${progressText}`);
      }
      break;
    case 'downloaded':
      btn.style.display = '';
      (iconDone as HTMLElement).style.display = '';
      btn.classList.add('update-available');
      btn.title = 'Update ready - click to install and restart';
      btn.setAttribute('aria-label', 'Update ready - click to install and restart');
      break;
    case 'error':
      btn.style.display = '';
      (iconCheck as HTMLElement).style.display = '';
      btn.classList.add('update-error');
      btn.title = 'Update check failed - click to retry';
      btn.setAttribute('aria-label', 'Update check failed - click to retry');
      break;
  }
}

async function handleUpdateClick(): Promise<void> {
  switch (updateState) {
    case 'idle':
    case 'error':
      // Check for updates
      updateInfo = null;
      downloadReceipt = null;
      setUpdateBtn('checking');
      try {
        const result = await api.updateCheck('manual');
        if (result.available && result.version && result.assetUrl) {
          updateInfo = { version: result.version, assetUrl: result.assetUrl, assetName: result.assetName ?? '', assetSize: result.assetSize };
          setUpdateBtn('update-available');
        } else {
          // Keep the manual check action visible after a successful no-update
          // result. Users can retry later without restarting the app; confirm
          // that the check succeeded so this doesn't look like a dead button.
          setUpdateBtn('idle');
          toast('info', 'No newer release available', 'There is no published version newer than this build.');
        }
      } catch {
        setUpdateBtn('error');
      }
      break;

    case 'update-available':
      // Download update
      if (!updateInfo) return;
      downloadPercent = Number.isSafeInteger(updateInfo.assetSize) && updateInfo.assetSize! > 0 ? 0 : Number.NaN;
      downloadedBytes = 0;
      setUpdateBtn('downloading');
      try {
        const dl = await api.updateDownload(updateInfo.assetUrl);
        downloadReceipt = dl.token;
        setUpdateBtn('downloaded');
      } catch {
        setUpdateBtn('error');
      }
      break;

    case 'downloaded':
      // Install and restart
      if (!downloadReceipt) return;
      try {
        await api.updateInstall(downloadReceipt);
      } catch {
        setUpdateBtn('error');
      }
      break;

    default:
      break;
  }
}

export function initTitlebar(): void {
  document.querySelector('.window-btn[data-op="minimize"]')
    ?.addEventListener('click', () => { void api.windowMinimize(); });
  document.querySelector(MAX_BTN_SEL)
    ?.addEventListener('click', () => { void api.windowMaximizeToggle(); });
  document.querySelector('.window-btn[data-op="close"]')
    ?.addEventListener('click', () => { void api.windowClose(); });

  api.onUpdateDownloadProgress(({ percent, downloadedBytes: bytes }) => {
    if (updateState !== 'downloading') return;
    downloadedBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : downloadedBytes;
    downloadPercent = typeof percent === 'number' && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, percent))
      : Number.NaN;
    const btn = document.getElementById('titlebar-update-btn');
    if (!btn) return;
    const progressText = Number.isFinite(downloadPercent)
      ? `${Math.round(downloadPercent)}%`
      : `${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB downloaded`;
    const label = `Downloading update... ${progressText}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  });

  // M4-D: the max button icon follows the live maximize state (main pushes
  // window:maximized-changed on maximize/unmaximize). M4J (F): ONE svg -
  // the two inner groups are class-toggled (the pre-M4J markup hid one of
  // TWO svg elements; the repeat request). Maximized -> the
  // icon-state-restore class shows the restore group (overlapping squares);
  // else the maximize group (the single hollow square).
  api.onWindowMaximizedChanged(({ maximized }) => {
    const btn = document.querySelector<HTMLButtonElement>(MAX_BTN_SEL);
    if (!btn) return;
    btn.title = maximized ? 'Restore' : 'Maximize';
    btn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
    const svg = btn.querySelector<SVGElement>('.icon-maximize-restore');
    svg?.classList.toggle('icon-state-restore', maximized);
  });
}

/** Attach the updater control after the sidebar has been rendered. */
export function initUpdaterControl(button: HTMLButtonElement): void {
  if (button.dataset.updaterWired !== 'true') {
    button.addEventListener('click', () => { void handleUpdateClick(); });
    button.dataset.updaterWired = 'true';
  }
  setUpdateBtn(updateState);
}

/** Trigger the automatic startup update check. */
export async function startupUpdateCheck(): Promise<void> {
  updateInfo = null;
  downloadReceipt = null;
  setUpdateBtn('checking');
  try {
    const result = await api.updateCheck('startup');
    if (result.available && result.version && result.assetUrl) {
      updateInfo = { version: result.version, assetUrl: result.assetUrl, assetName: result.assetName ?? '', assetSize: result.assetSize };
      setUpdateBtn('update-available');
    } else {
      setUpdateBtn('idle');
    }
  } catch {
    // Keep a retry affordance visible. A transient GitHub/API/network failure
    // must not look identical to "no update available".
    setUpdateBtn('error');
  }
}
