// Native window identity selects these permissions. Renderer payloads never
// select a role, a target window, or a document path.
export const TAURI_ROLE_CHANNELS = Object.freeze({
  overlay: ['list-devices', 'device-get', 'device-preferred-get', 'sysinfo:get', 'display:get', 'fps-poll', 'overlay-telemetry-start', 'overlay-resize'],
  'advanced-overlay': [
    'advanced-overlay:close', 'list-devices', 'device-get', 'device-preferred-get', 'device-selection-request',
    'get-capabilities', 'get-current-settings', 'telemetry-latest', 'advanced-mode-accepted-get',
    'advanced-mode-accepted-set', 'oc-mode-set', 'apply-settings', 'voltage-offset:read', 'waiver-accept',
    'graphics:get', 'graphics:apply', 'recording-settings-get', 'recording-settings-save', 'recording-status',
    'recording-capture-targets', 'profiles-list', 'profiles-settings-save', 'recording-start',
    'recording-replay-start', 'recording-stop', 'recording-clip-save', 'recording-choose-folder',
    'recording-open-folder', 'stream-status', 'stream-scenes', 'stream-scene-set', 'stream-connect',
    'stream-disconnect', 'stream-start', 'stream-stop', 'stream-microphone-mute', 'stream-duck',
  ],
  'recording-toast': [],
  'recording-status-pill': [],
  splash: ['splash:update-now', 'splash:update-choice'],
});
export const TAURI_ROLE_EVENTS = Object.freeze({
  overlay: ['overlay:settings', 'telemetry:sample', 'device-selection:updated'],
  'advanced-overlay': ['advanced-overlay:settings', 'telemetry:sample', 'device:state-updated',
    'graphics:state-updated', 'recording:settings', 'recording:pill-settings', 'recording:state',
    'device-selection:updated', 'oc-mode:updated'],
  'recording-toast': ['recording:notification'],
  'recording-status-pill': ['recording:state'],
  splash: ['splash:update-status'],
});
export function tauriWindowRole(target) {
  if (target === 'main') return 'main';
  if (typeof target !== 'string') return null;
  const match = /^(overlay|advanced-overlay|recording-toast|recording-status-pill|splash)-([1-9]\d{5,14})$/.exec(target);
  return match && Number.isSafeInteger(Number(match[2])) ? match[1] : null;
}
