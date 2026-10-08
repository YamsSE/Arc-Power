// Electron-free orchestration for the startup Update Now handoff. The main
// process supplies the real download/install operations; tests supply fakes.

function availableErrorStatus() {
  return {
    state: 'available',
    percent: 0,
    error: true,
    message: 'Update failed — choose UPDATE NOW to retry or SKIP FOR NOW',
  };
}

export function createStartupUpdateHandoff({
  coordinator,
  buildKind,
  portableWrapperPath = null,
  downloadUpdate,
  installUpdate,
  completeUpdate = (result) => coordinator.completeUpdate(result),
} = {}) {
  if (!coordinator || typeof coordinator.startupResult !== 'function') {
    throw new TypeError('startup update coordinator is required');
  }
  if (typeof downloadUpdate !== 'function') throw new TypeError('downloadUpdate function is required');
  if (typeof installUpdate !== 'function') throw new TypeError('installUpdate function is required');

  let inFlight = null;
  const setStatus = (status) => coordinator.setStatus(status);

  const updateNow = () => {
    if (inFlight) return inFlight;
    const operation = (async () => {
      const result = await coordinator.startupResult();
      if (coordinator.fatalSplashFailed()) return { ok: false, action: 'abort' };
      if (!result?.available || !result.assetUrl) throw new Error('No startup update is available');

      const choice = coordinator.choose('update');
      if (!choice.ok) return { ok: false, action: 'abort' };
      const knownSize = Number.isSafeInteger(result.assetSize) && result.assetSize > 0 ? result.assetSize : null;
      setStatus({ state: 'downloading', percent: knownSize ? 0 : null, message: knownSize ? 'Downloading update... 0%' : 'Downloading update...' });
      const downloadReceipt = await downloadUpdate(result.assetUrl, (progress) => {
        const percent = Number.isFinite(progress?.percent) ? progress.percent : null;
        const message = percent === null
          ? `Downloading update... ${(Math.max(0, Number(progress?.downloadedBytes) || 0) / (1024 * 1024)).toFixed(1)} MB`
          : `Downloading update... ${percent}%`;
        setStatus({ state: 'downloading', percent, message });
      }, buildKind);
      // A fatal renderer failure can happen while the download is in flight.
      // Never start a replacement after that process has been told to quit.
      if (coordinator.fatalSplashFailed()) return { ok: false, action: 'abort' };

      setStatus({ state: 'restarting', percent: 100, message: 'Update downloaded — restarting Arc Power' });
      const handoff = await installUpdate(downloadReceipt.token, {
        buildKind,
        portableWrapperPath,
        onHandoffStarted: () => coordinator.markHandoffStarted?.(),
      });
      if (coordinator.fatalSplashFailed()) return { ok: false, action: 'abort' };
      // The installer and portable helper must wait for this process to exit
      // before they can copy or relaunch. A child-process `spawn` event is
      // therefore only a detached handoff, never proof that the replacement
      // succeeded. Keep startup gated; the portable helper writes a durable
      // result and presents recovery details if replacement or relaunch fails.
      if (handoff?.restartConfirmed === true) {
        const completed = completeUpdate(handoff);
        if (!completed.ok) throw new Error('Startup update handoff did not resolve the restart gate');
        return { ok: true, handoff };
      }
      return { ok: true, action: 'restart-pending', handoff };
    })().catch((cause) => {
      if (coordinator.fatalSplashFailed()) return { ok: false, action: 'abort' };
      setStatus(availableErrorStatus());
      throw cause;
    });
    let tracked;
    tracked = operation.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  return {
    updateNow,
    inFlight: () => inFlight,
  };
}
