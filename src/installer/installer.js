const api = window.arcPowerInstaller;
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'uninstall' ? 'uninstall' : 'install';

const $ = (id) => document.getElementById(id);
const installForm = $('install-form');
const installDirectory = $('install-directory');
const initialInstallDirectory = installDirectory.value;
const browseButton = $('browse-button');
const desktopShortcut = $('desktop-shortcut');
const launchAfter = $('launch-after');
const rtssRow = $('rtss-row');
const installRtss = $('install-rtss');
const rtssInstalledNote = $('rtss-installed-note');
const progressArea = $('progress-area');
const progressMessage = $('progress-message');
const progressPercent = $('progress-percent');
const progressValue = $('progress-value');
const statusCard = $('status-card');
const statusTitle = $('status-title');
const statusDetail = $('status-detail');
const error = $('error');
const primaryButton = $('primary-button');
const cancelButton = $('cancel-button');

let busy = false;
let completed = false;
let closeRequested = false;

function closeInstaller() {
  if (closeRequested) return;
  closeRequested = true;
  Promise.resolve()
    .then(() => api.close())
    .catch(() => { closeRequested = false; });
}

function setView(view) {
  document.body.dataset.state = view;
}

function setError(message) {
  error.textContent = message;
  error.hidden = !message;
}

function setProgress(percent, message) {
  progressArea.hidden = false;
  progressMessage.textContent = message;
  progressPercent.textContent = `${percent}%`;
  progressValue.style.width = `${percent}%`;
}

function setBusy(value) {
  busy = value;
  primaryButton.disabled = value;
  browseButton.disabled = value;
  cancelButton.disabled = value;
  installDirectory.disabled = value;
  desktopShortcut.disabled = value;
  launchAfter.disabled = value;
  installRtss.disabled = value;
  $('actions').hidden = value && !completed;
}

function showComplete({ uninstall = false, launched = false, rtss = null } = {}) {
  completed = true;
  setBusy(false);
  setView('complete');
  installForm.hidden = true;
  statusCard.hidden = false;
  statusTitle.textContent = uninstall ? 'Arc Power removal is in progress' : 'Arc Power is ready';
  if (uninstall) {
    statusDetail.textContent = 'Your profiles are kept. This window is closing while the application files and Windows registration are cleaned up.';
  } else {
    const launchText = launched ? 'The Arc Power control panel is opening now.' : 'You can launch Arc Power from the Start Menu any time.';
    const rtssText = rtss?.installed
      ? ' RTSS is ready for native FPS and frametime values.'
      : rtss?.reason === 'not-requested'
        ? ' RTSS was skipped; Arc Power will use its DXGI fallback until RTSS is installed.'
        : ' RTSS could not be installed automatically; Arc Power will use its DXGI fallback until RTSS is installed.';
    statusDetail.textContent = `${launchText}${rtssText}`;
  }
  primaryButton.textContent = uninstall ? 'CLOSE' : 'CLOSE SETUP';
  cancelButton.hidden = true;
  progressArea.hidden = false;
  setProgress(uninstall ? 96 : 100, uninstall ? 'Removal in progress — closing' : 'Installation complete');
  if (uninstall) {
    const closeAfterPaint = () => setTimeout(closeInstaller, 120);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(closeAfterPaint);
    else setTimeout(closeAfterPaint, 0);
  }
}

async function runInstall() {
  if (busy) return;
  setError('');
  setView('busy');
  installForm.hidden = true;
  setBusy(true);
  try {
    const result = await api.install({
      installDir: installDirectory.value.trim(),
      createDesktopShortcut: desktopShortcut.checked,
      launchAfterInstall: launchAfter.checked,
      installRtss: installRtss.checked,
    });
    showComplete({ launched: result.launched, rtss: result.rtss });
  } catch (cause) {
    setBusy(false);
    setView('idle');
    installForm.hidden = false;
    setError(cause?.message || 'Arc Power could not be installed.');
    setProgress(0, 'Installation needs attention');
  }
}

async function runUninstall() {
  if (busy) return;
  setError('');
  setView('busy');
  setBusy(true);
  try {
    await api.uninstall();
    showComplete({ uninstall: true });
  } catch (cause) {
    setBusy(false);
    setView('idle');
    setError(cause?.message || 'Arc Power could not be removed.');
    setProgress(0, 'Removal needs attention');
  }
}

browseButton.addEventListener('click', async () => {
  if (busy) return;
  const chosen = await api.chooseDirectory();
  if (chosen) installDirectory.value = chosen;
});
cancelButton.addEventListener('click', () => { if (!busy) closeInstaller(); });
primaryButton.addEventListener('click', () => {
  if (completed) closeInstaller();
  else if (mode === 'uninstall') runUninstall();
  else runInstall();
});
$('close-button').addEventListener('click', () => { if (!busy) closeInstaller(); });
api.onProgress(({ percent, message }) => setProgress(percent, message));

if (mode === 'uninstall') {
  setView('idle');
  $('eyebrow').textContent = 'ARC POWER / UNINSTALL';
  $('headline').innerHTML = 'Clear the<br><span>runway.</span>';
  $('lede').textContent = 'This removes the Arc Power application, shortcuts and Windows registration. Your durable ArcPower profiles stay safely in place.';
  installForm.hidden = true;
  primaryButton.textContent = 'REMOVE ARC POWER';
  cancelButton.textContent = 'KEEP ARC POWER';
} else {
  setView('idle');
}

api.getState().then((state) => {
  if (mode === 'uninstall') {
    const previous = state.lastUninstallStatus;
    if (previous && previous.state !== 'complete') {
      const diagnostic = previous.diagnosticPath ? ` Diagnostics: ${previous.diagnosticPath}` : '';
      setError(`The previous removal attempt did not finish. Click REMOVE ARC POWER to retry. ${previous.message}${diagnostic}`);
    }
    return;
  }
  if (!installDirectory.value.trim() || installDirectory.value === initialInstallDirectory) {
    installDirectory.value = state.installDir;
  }
  $('version-label').textContent = `VERSION ${state.version}`;
  if (state.rtss?.installed) {
    rtssRow.hidden = true;
    rtssInstalledNote.hidden = false;
  }
  if (!state.payloadReady) setError('The packaged application payload is unavailable. Rebuild the installer before installing.');
}).catch((cause) => setError(cause?.message || 'Setup could not read its installation state.'));
