const api = window.arcPowerInstaller;
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') === 'uninstall' ? 'uninstall' : 'install';

const $ = (id) => document.getElementById(id);
const installForm = $('install-form');
const installDirectory = $('install-directory');
const browseButton = $('browse-button');
const desktopShortcut = $('desktop-shortcut');
const launchAfter = $('launch-after');
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
  $('actions').hidden = value && !completed;
}

function showComplete({ uninstall = false, launched = false } = {}) {
  completed = true;
  setBusy(false);
  setView('complete');
  installForm.hidden = true;
  statusCard.hidden = false;
  statusTitle.textContent = uninstall ? 'Arc Power has been removed' : 'Arc Power is ready';
  statusDetail.textContent = uninstall
    ? 'Your profiles were kept. The disposable cache and application files are gone.'
    : (launched ? 'The Arc Power control panel is opening now.' : 'You can launch Arc Power from the Start Menu any time.');
  primaryButton.textContent = uninstall ? 'CLOSE' : 'CLOSE SETUP';
  cancelButton.hidden = true;
  progressArea.hidden = false;
  setProgress(100, uninstall ? 'Removal complete' : 'Installation complete');
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
    });
    showComplete({ launched: result.launched });
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
cancelButton.addEventListener('click', () => { if (!busy) api.close(); });
primaryButton.addEventListener('click', () => {
  if (completed) api.close();
  else if (mode === 'uninstall') runUninstall();
  else runInstall();
});
$('close-button').addEventListener('click', () => { if (!busy) api.close(); });
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
  api.getState().then((state) => {
    installDirectory.value = state.installDir;
    $('version-label').textContent = `VERSION ${state.version}`;
    if (!state.payloadReady) setError('The packaged application payload is unavailable. Rebuild the installer before installing.');
  }).catch((cause) => setError(cause?.message || 'Setup could not read its installation state.'));
}
