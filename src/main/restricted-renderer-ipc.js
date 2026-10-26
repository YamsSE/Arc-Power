const ADVANCED_OVERLAY_GLOBAL_CHANNELS = new Set([
  'postprocess-sharpening:get',
  'postprocess-sharpening:set',
  'arc-super-resolution:get',
  'arc-super-resolution:set',
]);

export function isAuthorizedRestrictedRendererIpc(channel, event, { getWindow, getAdvancedOverlayWindow }) {
  const main = getWindow();
  if (main && !main.isDestroyed() && event.sender === main.webContents) return true;
  if (!ADVANCED_OVERLAY_GLOBAL_CHANNELS.has(channel)) return false;
  const overlay = getAdvancedOverlayWindow();
  return !!overlay && !overlay.isDestroyed()
    && event.sender === overlay.webContents
    && event.senderFrame === overlay.webContents.mainFrame;
}
