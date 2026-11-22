import { createTauriBroker } from './tauri-broker.js';
import { createTauriWindowProxy } from './tauri-window-proxy.js';
import { TAURI_ROLE_CHANNELS, TAURI_ROLE_EVENTS } from '../shared/tauri-roles.js';

export const TAURI_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;

/** Private pipe adapter around the existing product dispatcher and services. */
export function createTauriServiceMode({ token, input, output, hostProcessId, onDisconnect = () => {}, onWindowClosed = () => {}, recordingStatusPillOwnerTimeoutMs = 10_000 }) {
  if (!Number.isFinite(recordingStatusPillOwnerTimeoutMs) || recordingStatusPillOwnerTimeoutMs < 1 || recordingStatusPillOwnerTimeoutMs > 30_000) {
    throw new TypeError('Invalid native recording status pill owner timeout');
  }
  const handlers = new Map();
  const privateHandlers = new Map();
  const privateCloseHandlers = new Set();
  const windows = new Map();
  let nextWindow = 1_000_000;
  let window = null;
  let mediaHandler = null;
  let nativeTelemetryHandler = null;
  let nativeTelemetryTargetHandler = null;
  let shortcutHandler = null;
  let powerHandler = null;
  let trayActionHandler = null;
  let recordingStateHandler = null;
  let recordingActionResultHandler = null;
  let settingsSnapshotHandler = null;
  let recordingStatusPillOwnerReady = false;
  let recordingStatusPillOwnerUnavailable = false;
  let recordingStatusPillOwnerHandler = null;
  let startupUpdateDecision = null;
  const startupUpdateDecisionWaiters = new Set();
  let serviceDisconnected = false;
  const recordingStatusPillOwnerWaiters = new Set();
  let ready = false;
  const broker = createTauriBroker({
    token, input, output,
    getAllowedChannels: () => handlers.keys(),
    getPrivateChannels: () => privateHandlers.keys(),
    invoke: (channel, args, target = 'main') => {
      const sender = windows.get(target);
      if (!sender || sender.isDestroyed() || (!ready && sender.role !== 'splash')) throw new Error('Arc Power services are not ready');
      if (sender.role !== 'main' && !TAURI_ROLE_CHANNELS[sender.role]?.includes(channel)) throw new Error('Command is unavailable to this window');
      const handler = handlers.get(channel);
      if (!handler) throw new Error('Unknown Arc Power command');
      // Authority is assigned by the native host and this private closure.
      // Neither event identity nor renderer role is accepted in the payload.
      return handler(sender.trustedEvent(), ...args);
    },
    invokePrivate: (channel, args, target = 'main') => {
      if (target !== 'main' || !ready || !windows.has('main')) throw new Error('Private broker operation is restricted to a ready native host');
      const handler = privateHandlers.get(channel);
      if (!handler) throw new Error('Unknown private broker operation');
      return handler(...args);
    },
    onHostWindowEvent: async (event, payload, target = 'main') => {
      if (event === 'startup-update-decision' && target === 'main') {
        const action = payload?.action;
        if (action === 'continue' || action === 'abort') {
          startupUpdateDecision = { action };
          for (const resolve of startupUpdateDecisionWaiters) resolve(startupUpdateDecision);
          startupUpdateDecisionWaiters.clear();
        }
        return;
      }
      if (event === 'recording-status-pill-owner-ready' && target === 'main') {
        recordingStatusPillOwnerReady = true;
        recordingStatusPillOwnerUnavailable = false;
        for (const waiter of recordingStatusPillOwnerWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(true);
        }
        recordingStatusPillOwnerWaiters.clear();
        try { recordingStatusPillOwnerHandler?.(); } catch { /* optional late settings sync */ }
        return;
      }
      if (event === 'recording-status-pill-owner-unavailable' && target === 'main') {
        recordingStatusPillOwnerUnavailable = true;
        for (const waiter of recordingStatusPillOwnerWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(false);
        }
        recordingStatusPillOwnerWaiters.clear();
        return;
      }
      if (event === 'telemetry-sample') {
        try { nativeTelemetryHandler?.(payload); } catch { /* optional RTSS consumer */ }
        return;
      }
      if (event === 'telemetry-target') {
        try { nativeTelemetryTargetHandler?.(payload?.target ?? null); } catch { /* optional OS-stats consumer */ }
        return;
      }
      if (event === 'shortcut') {
        try { shortcutHandler?.(payload); } catch { /* optional host-shortcut consumer */ }
        return;
      }
      if (event === 'power') {
        try { powerHandler?.(payload); } catch { /* optional power consumer */ }
        return;
      }
      if (event === 'tray-action') {
        try { trayActionHandler?.(payload); } catch { /* optional tray consumer */ }
        return;
      }
      if (event === 'recording-state') {
        try { recordingStateHandler?.(payload); } catch { /* optional desktop-indicator consumer */ }
        return;
      }
      if (event === 'recording-action-result') {
        try { recordingActionResultHandler?.(payload); } catch { /* optional desktop-toast consumer */ }
        return;
      }
      // A whole settings snapshot pushed after a native `profiles-settings-save`.
      // This branch must be TOTAL: a host-event handler that throws closes the
      // broker and quits the app, so a malformed payload is consumed silently
      // and the consumer's own failure never escapes.
      if (event === 'settings-cache') {
        const snapshot = payload?.settings;
        if (target === 'main' && snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
          try { settingsSnapshotHandler?.(snapshot); } catch { /* optional settings-cache consumer */ }
        }
        return;
      }
      windows.get(target)?.receiveHostEvent(event, payload);
    },
    onMediaRequest: async (request) => {
      if (!ready || !mediaHandler) throw new Error('Recording media is not ready');
      return boundedTauriMediaResponse(mediaHandler, request);
    },
    onClose: reason => {
      serviceDisconnected = true;
      if (!startupUpdateDecision) {
        startupUpdateDecision = { action: 'abort' };
        for (const resolve of startupUpdateDecisionWaiters) resolve(startupUpdateDecision);
      }
      startupUpdateDecisionWaiters.clear();
      for (const closeHandler of privateCloseHandlers) {
        try { closeHandler(reason); } catch { /* private lease teardown is fail closed */ }
      }
      privateCloseHandlers.clear();
      for (const waiter of recordingStatusPillOwnerWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Native recording status pill ownership handshake failed: ${reason}`));
      }
      recordingStatusPillOwnerWaiters.clear();
      onDisconnect(reason);
    },
  });
  return {
    start: () => broker.start(),
    requestNativeStore: (...args) => broker.requestNativeStore(...args),
    register: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate Arc Power command: ${channel}`);
      handlers.set(channel, handler);
    },
    registerPrivate: (channel, handler, { onClose } = {}) => {
      if (typeof channel !== 'string' || !/^__native-[a-z0-9-]+:[a-z0-9-]+$/.test(channel)) throw new TypeError('Invalid private native broker operation');
      if (privateHandlers.has(channel) || handlers.has(channel)) throw new Error(`Duplicate Arc Power private operation: ${channel}`);
      if (typeof handler !== 'function') throw new TypeError('Private native broker operation requires a handler');
      privateHandlers.set(channel, handler);
      if (typeof onClose === 'function') privateCloseHandlers.add(onClose);
    },
    publishAvailable: () => broker.ready({ phase: 'splash' }),
    initializing: () => broker.ready({ phase: 'initializing' }),
    setMediaHandler: handler => { mediaHandler = handler; },
    setNativeTelemetryHandler(handler) { nativeTelemetryHandler = typeof handler === 'function' ? handler : null; },
    setNativeTelemetryTargetHandler(handler) { nativeTelemetryTargetHandler = typeof handler === 'function' ? handler : null; },
    setShortcutHandler(handler) { shortcutHandler = typeof handler === 'function' ? handler : null; },
    setPowerHandler(handler) { powerHandler = typeof handler === 'function' ? handler : null; },
    setTrayActionHandler(handler) { trayActionHandler = typeof handler === 'function' ? handler : null; },
    setRecordingStateHandler(handler) { recordingStateHandler = typeof handler === 'function' ? handler : null; },
    setRecordingActionResultHandler(handler) { recordingActionResultHandler = typeof handler === 'function' ? handler : null; },
    setSettingsSnapshotHandler(handler) { settingsSnapshotHandler = typeof handler === 'function' ? handler : null; },
    waitForRecordingStatusPillOwner() {
      if (recordingStatusPillOwnerReady) return Promise.resolve(true);
      if (recordingStatusPillOwnerUnavailable) return Promise.resolve(false);
      if (serviceDisconnected) return Promise.reject(new Error('Native recording status pill owner is unavailable'));
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          recordingStatusPillOwnerWaiters.delete(waiter);
          resolve(false);
        }, recordingStatusPillOwnerTimeoutMs);
        recordingStatusPillOwnerWaiters.add(waiter);
      });
    },
    setRecordingStatusPillOwnerHandler(handler) {
      recordingStatusPillOwnerHandler = typeof handler === 'function' ? handler : null;
      if (recordingStatusPillOwnerReady) recordingStatusPillOwnerHandler?.();
    },
    waitForStartupUpdateDecision() {
      if (startupUpdateDecision) return Promise.resolve(startupUpdateDecision);
      if (serviceDisconnected) return Promise.reject(new Error('Native startup update coordinator is unavailable'));
      return new Promise(resolve => startupUpdateDecisionWaiters.add(resolve));
    },
    createWindow({ bounds, maximized = false, show = true, persistWindowState }) {
      if (window) throw new Error('Only one main host window is allowed');
      const completeBounds = { x: 0, y: 0, ...bounds };
      window = createTauriWindowProxy({
        role: 'main',
        bounds: completeBounds, hostProcessId,
        sendHostOperation: (...args) => broker.hostOperation(...args),
        emitToMain: (...args) => broker.emitToMain(...args),
        onError: error => console.error(`[tauri] ${error.message}`),
      });
      windows.set('main', window);
      const persist = () => {
        persistWindowState?.(window.getNormalBounds(), window.isMaximized());
      };
      window.on('move', persist);
      window.on('resize', persist);
      window.on('close', persist);
      const emitMaximized = () => window.webContents.send('window:maximized-changed', { maximized: window.isMaximized() });
      window.on('maximize', () => { persist(); emitMaximized(); });
      window.on('unmaximize', () => { persist(); emitMaximized(); });
      window.webContents.on('did-finish-load', emitMaximized);
      window.once('ready-to-show', () => {
        window.setBounds(completeBounds);
        if (maximized) window.maximize();
        if (show) window.show();
      });
      window.once('closed', onWindowClosed);
      return window;
    },
    createAuxWindow(role, options = {}) {
      if (!(role in TAURI_ROLE_CHANNELS)) throw new Error('Unknown auxiliary window role');
      const target = `${role}-${nextWindow++}`;
      const bounds = { x: 0, y: 0, width: options.width, height: options.height, ...Object.fromEntries(['x', 'y'].filter(key => Number.isFinite(options[key])).map(key => [key, options[key]])) };
      const queued = [];
      let created = false;
      const proxy = createTauriWindowProxy({
        role, target, bounds, hostProcessId,
        sendHostOperation(operation, args) {
          if (!created) { queued.push([operation, args]); return Promise.resolve(); }
          return broker.hostOperation(operation, args);
        },
        emitToMain(channel, ...args) {
          if (!TAURI_ROLE_EVENTS[role].includes(channel)) return Promise.reject(new Error('Event is unavailable to this window'));
          return broker.emitToWindow(target, channel, ...args);
        },
        async loadDocument({ query }) {
          if (created) throw new Error('Native auxiliary document is already loading');
          await broker.hostOperation('window', { action: 'create', target, role, bounds, ...(query.theme ? { theme: query.theme } : {}) });
          created = true;
          for (const [operation, args] of queued.splice(0)) await broker.hostOperation(operation, args);
        },
        onError: error => console.error(`[tauri:${role}] ${error.message}`),
      });
      windows.set(target, proxy);
      proxy.once('closed', () => { if (windows.get(target) === proxy) windows.delete(target); });
      return proxy;
    },
    async ready() { ready = true; await broker.ready(); },
    drain: options => broker.drain(options),
    hostOperation: (...args) => broker.hostOperation(...args),
    close: reason => broker.close(reason),
  };
}

/** Resolve opaque media through the unchanged safe resolver, never a file path. */
export async function boundedTauriMediaResponse(handler, request) {
  const response = await handler(request, { maxBodyBytes: TAURI_MEDIA_CHUNK_BYTES });
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > TAURI_MEDIA_CHUNK_BYTES) {
          await reader.cancel();
          return { status: 413, headers: { 'Content-Length': '0' }, bodyBase64: '' };
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), bodyBase64: Buffer.concat(chunks, length).toString('base64') };
}
