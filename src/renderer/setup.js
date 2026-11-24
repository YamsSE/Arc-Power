const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const $ = (id) => document.getElementById(id);
const mode = window.__arcSetupMode === 'uninstall' ? 'uninstall' : 'install';
let plan = null;

function show(page) {
  for (const section of document.querySelectorAll('.setup-page')) section.classList.remove('active');
  $(`page-${page}`).classList.add('active');
}

function close() {
  void invoke('setup_close');
}

function finish(title, copy, kicker = 'COMPLETE') {
  $('finish-kicker').textContent = kicker;
  $('finish-title').textContent = title;
  $('finish-copy').textContent = copy;
  show('finish');
}

async function startInstall() {
  const path = $('install-path').value.trim();
  if (!path) { $('options-error').textContent = 'Choose an install folder.'; return; }
  const desktop = $('opt-desktop').checked;
  const launch = $('opt-launch').checked;
  const rtss = $('opt-rtss').checked && !plan.rtssInstalled;
  $('options-error').textContent = '';
  $('progress-title').textContent = 'Installing Arc Power';
  $('progress-copy').textContent = 'Copying the application, registering it with Windows and creating shortcuts.';
  $('progress-error').textContent = '';
  $('progress-actions').hidden = true;
  show('progress');
  try {
    const result = await invoke('setup_install', { path, desktop, launch, rtss });
    const note = result && result.rtss ? ` ${result.rtss}` : '';
    finish('Arc Power is installed', `Setup completed.${note}`);
  } catch (error) {
    $('progress-title').textContent = 'Setup could not complete';
    $('progress-copy').textContent = 'The previous installation and Windows registration were restored where possible.';
    $('progress-error').textContent = String(error);
    $('progress-actions').hidden = false;
  }
}

async function startUninstall() {
  $('progress-title').textContent = 'Removing Arc Power';
  $('progress-copy').textContent = 'The application, Arc Power caches and saved profiles under AppData\\ArcPower are being removed. Recordings elsewhere are kept.';
  $('progress-error').textContent = '';
  $('progress-actions').hidden = true;
  show('progress');
  try {
    await invoke('setup_uninstall');
    finish('Arc Power has been removed', 'The application and its Arc Power data were removed. Close this window to finish.', 'COMPLETE');
  } catch (error) {
    $('progress-title').textContent = 'Removal could not complete';
    $('progress-copy').textContent = 'Run Remove Arc Power again from Windows Settings if the folder remains.';
    $('progress-error').textContent = String(error);
    $('progress-actions').hidden = false;
  }
}

async function main() {
  plan = await invoke('setup_state');
  $('setup-version').textContent = `Version ${plan.version}`;
  $('install-path').value = plan.currentDir || plan.defaultDir || '';
  $('opt-desktop').checked = true;
  $('opt-launch').checked = true;
  if (plan.rtssInstalled) {
    $('opt-rtss').checked = false;
    $('opt-rtss').disabled = true;
    $('rtss-note').textContent = 'RTSS is already installed.';
  } else {
    $('rtss-note').textContent = 'Optional. RTSS enables FPS and frame-pacing overlay readings.';
  }
  if (mode === 'uninstall') {
    $('welcome-title').textContent = 'Remove Arc Power';
    $('welcome-copy').textContent = 'This removes the application, Arc Power caches, and saved profiles under AppData\\ArcPower. Recordings and files elsewhere are kept.';
    $('welcome-next').textContent = 'Remove';
    $('welcome-next').addEventListener('click', () => void startUninstall());
  } else {
    $('welcome-title').textContent = `Welcome to Arc Power ${plan.version}`;
    $('welcome-next').addEventListener('click', () => show('options'));
    $('options-back').addEventListener('click', () => show('welcome'));
    $('install').addEventListener('click', () => void startInstall());
    $('browse').addEventListener('click', () => {
      void invoke('setup_pick_folder', { current: $('install-path').value }).then((chosen) => {
        if (chosen) $('install-path').value = chosen;
      }).catch((error) => { $('options-error').textContent = String(error); });
    });
  }
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close));
  $('finish-close').addEventListener('click', close);
  $('progress-close').addEventListener('click', close);
  $('progress-back').addEventListener('click', () => show(mode === 'uninstall' ? 'welcome' : 'options'));
}

void main().catch((error) => {
  $('progress-title').textContent = 'Setup could not start';
  $('progress-copy').textContent = '';
  $('progress-error').textContent = String(error);
  $('progress-actions').hidden = false;
  show('progress');
});
