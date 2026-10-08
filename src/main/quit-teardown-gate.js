// Hold Electron's quit while Arc Sleep restores its journaled RTSS state.
// Repeated quit requests must not bypass an in-flight asynchronous teardown.
export function createQuitTeardownGate({ getTeardown, closeRtssHelper, quit } = {}) {
  let teardownStarted = false;
  let teardownComplete = false;
  let helperClosed = false;

  const closeHelperOnce = () => {
    if (helperClosed) return;
    helperClosed = true;
    try { closeRtssHelper?.(); } catch { /* best effort */ }
  };

  return (event) => {
    const teardown = getTeardown?.();
    if (typeof teardown === 'function' && !teardownComplete) {
      event.preventDefault();
      if (teardownStarted) return;
      teardownStarted = true;
      void Promise.resolve().then(() => teardown()).catch(() => {}).finally(() => {
        teardownComplete = true;
        closeHelperOnce();
        quit?.();
      });
      return;
    }
    closeHelperOnce();
  };
}
