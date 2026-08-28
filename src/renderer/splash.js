const status = document.querySelector('.splash-status');
const progress = document.querySelector('.splash-progress');
const progressValue = document.querySelector('.splash-progress-value');
const loadingStatus = document.getElementById('splash-loading-status');
const actions = document.querySelector('.splash-update-actions');
const updateNow = document.getElementById('splash-update-now');
const skipUpdate = document.getElementById('splash-skip-update');
let latestState = 'checking';

function render(payload = {}) {
  const { state, message, loadingMessage, percent, version, error } = payload;
  latestState = typeof state === 'string' ? state : 'checking';
  if (typeof message === 'string' && status) status.textContent = message;
  if (loadingStatus) {
    const showLoading = latestState === 'checking' || latestState === 'current' || latestState === 'error' || latestState === 'skipped';
    loadingStatus.hidden = !showLoading;
    if (typeof loadingMessage === 'string') loadingStatus.textContent = loadingMessage;
    else if (showLoading) loadingStatus.textContent = 'Loading Arc Power...';
  }
  document.body.dataset.updateState = latestState;
  if (progress) {
    progress.setAttribute('aria-label', typeof loadingMessage === 'string' ? loadingMessage : 'Loading Arc Power');
    if (Number.isFinite(percent)) progress.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, percent))));
    else progress.removeAttribute('aria-valuenow');
  }
  if (progressValue) {
    if (Number.isFinite(percent)) {
      progressValue.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      progressValue.classList.remove('splash-progress-indeterminate');
    } else {
      progressValue.style.width = '';
      progressValue.classList.add('splash-progress-indeterminate');
    }
  }
  const available = latestState === 'available';
  if (actions) actions.hidden = !available;
  if (updateNow) {
    updateNow.disabled = !available;
    updateNow.textContent = error ? 'RETRY UPDATE' : (version ? `UPDATE TO v${version}` : 'UPDATE NOW');
  }
  if (skipUpdate) skipUpdate.disabled = !available;
}

async function acceptUpdate() {
  if (latestState !== 'available' || !window.arcPowerSplash?.updateNow) return;
  if (updateNow) updateNow.disabled = true;
  if (skipUpdate) skipUpdate.disabled = true;
  try {
    await window.arcPowerSplash.updateNow();
  } catch {
    // Main publishes the recoverable available/error state. Keep the controls
    // hidden unless that state is actually received.
  }
}

async function skipUpdateForNow() {
  if (latestState !== 'available' || !window.arcPowerSplash?.skipUpdate) return;
  if (actions) actions.hidden = true;
  if (status) status.textContent = 'Starting Arc Power...';
  document.body.dataset.updateState = 'skipped';
  try { await window.arcPowerSplash.skipUpdate(); } catch { /* boot continues */ }
}

updateNow?.addEventListener('click', () => { void acceptUpdate(); });
skipUpdate?.addEventListener('click', () => { void skipUpdateForNow(); });
window.arcPowerSplash?.onUpdateStatus(render);
