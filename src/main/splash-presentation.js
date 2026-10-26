// Keep the loading splash passive, then make an actionable update prompt
// visible and keyboard-accessible once its document and window are ready.
const presentations = new WeakMap();

export function getSplashPresentation(splash) {
  if (presentations.has(splash)) return presentations.get(splash);
  let windowReady = false;
  let contentReady = false;
  let promptRequested = false;
  let promptPresented = false;
  let closed = false;

  const isUsable = () => !closed && !splash.isDestroyed();
  const presentPromptIfReady = () => {
    if (!promptRequested || promptPresented || !windowReady || !contentReady || !isUsable()) return;
    promptPresented = true;
    splash.setSkipTaskbar(false);
    splash.show();
    splash.focus();
  };

  const presentation = {
    windowReady() {
      windowReady = true;
      presentPromptIfReady();
    },
    contentReady() {
      contentReady = true;
      presentPromptIfReady();
    },
    close() { closed = true; },
    setStatus(status) {
      if (status?.state === 'available') {
        promptRequested = true;
        presentPromptIfReady();
      }
    },
  };
  presentations.set(splash, presentation);
  return presentation;
}
