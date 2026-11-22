const ADVANCED_OVERLAY_ALLOWED_CHANNELS = new Set([
  // The Advanced Overlay has real controls for these channels; all other
  // renderers with the shared preload must be denied them.
  'apply-settings',
  'graphics:apply',
  'recording-start',
  'stream-connect',
  'profiles-settings-save',
  'waiver-accept',
  'advanced-overlay:close',
  'advanced-mode-accepted-set',
  'device-selection-request',
  'oc-mode-set',
  'recording-settings-save',
  'recording-stop',
  'recording-replay-start',
  'recording-clip-save',
  'recording-choose-folder',
  'recording-open-folder',
  'stream-disconnect',
  'stream-scene-set',
  'stream-start',
  'stream-stop',
  'stream-microphone-mute',
  'stream-duck',
]);

// The shared preload is attached to auxiliary windows too. Keep these
// high-impact operations on the main renderer except for exact Advanced
// Overlay callsites listed in ADVANCED_OVERLAY_ALLOWED_CHANNELS above.
const MAIN_RENDERER_ONLY_CHANNELS = new Set([
  'registry-apply',
  'startup-set',
  'rtssStartupSet',
  'app:maintenance-restart',
  'app:clear-cache-restart',
  'display:apply',
  'reset-to-defaults',
  'device-set',
  'profiles-export',
  'recording-auto-start',
  'recording-runtime-acquire',
  'recording-runtime-release',
  'recording-clip-copy',
  'recording-clip-url',
  'recording-clips-list',
  'tray-rebuild',
  'intel-driver-download-start',
  'intel-driver-download-cancel',
  'intel-driver-download-delete',
  'intel-driver-install',
  'profiles-save',
  'profiles-delete',
  'profiles-rename',
  'profiles-import',
  'game-catalog-add',
  'game-catalog-sync',
  'game-settings-save',
  'game-settings-delete',
  'game-profile-save',
  'game-profile-delete',
  'recording-marker-add',
  'recording-clip-delete',
  'recording-editor-start',
  'recording-editor-cancel',
  'recording-editor-open',
  'recording-editor-share',
  'recording-editor-copy',
  'recording-editor-folder',
  'stability-run-start',
  'stability-run-cancel',
  'window-minimize',
  'window-maximize-toggle',
  'window-close',
  'overlay:toggle',
  'advanced-overlay:toggle',
  // This stream mutation has no current main/Advanced Overlay callsite. Keep
  // it unavailable to every auxiliary renderer until a sanctioned use exists.
  'stream-duck-restore',
]);

const RESTRICTED_CHANNEL_PREFIXES = [
  'update:',
  'postprocess-sharpening:',
  'arc-super-resolution:',
  'fan-resume:',
];

export function isMainRendererOnlyIpcChannel(channel) {
  return MAIN_RENDERER_ONLY_CHANNELS.has(channel);
}

export function isMainFrameIpcSender(event, win) {
  return !!win && !win.isDestroyed()
    && event?.sender === win.webContents
    && event?.senderFrame === win.webContents.mainFrame;
}

export function guardMainFrameIpcHandler(channel, getWindow, handler) {
  if (typeof getWindow !== 'function' || typeof handler !== 'function') {
    throw new TypeError('main-frame IPC handler requires a window resolver and handler');
  }
  return (event, ...args) => {
    if (!isMainFrameIpcSender(event, getWindow())) {
      throw new Error(`${channel} is restricted to its window main frame`);
    }
    return handler(event, ...args);
  };
}

export function isRestrictedRendererIpcChannel(channel) {
  return typeof channel === 'string' && (channel === 'device-selection-push'
    || isMainRendererOnlyIpcChannel(channel)
    || ADVANCED_OVERLAY_ALLOWED_CHANNELS.has(channel)
    || RESTRICTED_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix)));
}

export function isAuthorizedRestrictedRendererIpc(channel, event, { getWindow, getAdvancedOverlayWindow }) {
  if (!isRestrictedRendererIpcChannel(channel)) return false;
  const main = getWindow();
  if (isMainFrameIpcSender(event, main)) return true;
  if (isMainRendererOnlyIpcChannel(channel)) return false;
  if (!ADVANCED_OVERLAY_ALLOWED_CHANNELS.has(channel)) return false;
  return isMainFrameIpcSender(event, getAdvancedOverlayWindow());
}
