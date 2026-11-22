import { StringDecoder } from 'node:string_decoder';
import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeTauriWire, decodeTauriWire } from '../shared/tauri-wire.js';
import { tauriWindowRole } from '../shared/tauri-roles.js';

export const TAURI_RPC_PREFIX = '@arcpower-rpc:v1';
export const TAURI_RPC_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Connect only to the host's private local pipe; never accepts TCP endpoints. */
export function createTauriPipeTransport({ path = process.env.ARC_POWER_TAURI_PIPE, timeoutMs = 120_000 } = {}) {
  if (typeof path !== 'string' || !/^\\\\\.\\pipe\\ArcPower-Tauri-[A-Za-z0-9-]{16,128}$/.test(path)) throw new TypeError('Invalid private Tauri pipe path');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('Invalid pipe connection timeout');
  const socket = net.createConnection(path);
  const timer = setTimeout(() => socket.destroy(new Error('Private Tauri pipe connection timed out')), timeoutMs);
  socket.once('connect', () => clearTimeout(timer));
  socket.once('close', () => clearTimeout(timer));
  return { input: socket, output: socket, closeSocket: () => socket.destroy() };
}
export async function connectTauriPipeTransport(options) {
  const transport = createTauriPipeTransport(options);
  await new Promise((resolve, reject) => { transport.input.once('connect', resolve); transport.input.once('error', reject); });
  return transport;
}
export const TAURI_HOST_OPERATIONS = Object.freeze(['window', 'host-exit', 'host-relaunch', 'recording-pill-settings', 'maintenance-drained', 'startup-splash-dismiss']);
export const TAURI_NATIVE_STORE_METHODS = Object.freeze(['load-profiles', 'save-profiles', 'save-profile', 'delete-profile', 'load-settings', 'save-settings', 'patch-settings', 'save-arc-sleep-state', 'save-settings-with-arc-sleep', 'apply-overlay-layout', 'overlay-layout-load', 'overlay-layout-list-snapshot', 'overlay-layout-mutate-and-apply', 'overlay-layout-save', 'overlay-layout-rename', 'overlay-layout-select', 'overlay-layout-delete', 'stability-load', 'stability-list', 'stability-latest', 'stability-append', 'update-release-select', 'update-check', 'update-download', 'update-install', 'apply-transaction-begin', 'apply-transaction-activate', 'apply-transaction-finish', 'apply-transaction-cancel', 'temperature-refusal-cache-read', 'temperature-refusal-cache-record', 'temperature-refusal-cache-poison', 'registry-apply-plan', "game-load", "game-save", "game-upsert", "game-delete", "game-cleanup-profile", "game-load-catalog", "game-has-catalog-path", "game-sync-catalog", "game-add-catalog-entry", "game-save-settings", "game-delete-settings", "recording-load", "recording-settings", "recording-save-settings", "recording-demote-encoder", "recording-list-clips", "recording-scan-clips", "recording-replace-clips", "recording-add-marker", "recording-list-markers", "recording-record-clip", "recording-attach-markers-to-clip", "recording-clip-by-id", "recording-delete-clip", 'fan-resume-list', 'fan-resume-get', 'fan-resume-set', 'fan-resume-remove', 'window-state-load', 'window-state-save', 'window-state-restore', 'window-state-save-current', 'obs-credential-load', 'obs-credential-save', 'rtss-profile-state', 'rtss-profile-apply', 'rtss-frame-limit-get', 'rtss-frame-limit-ownership', 'rtss-frame-limit-apply', 'rtss-frame-limit-restore', 'rtss-frame-limit-restore-state', 'rtss-sharpening-compatibility']);
const nativeStoreMethods = new Set(TAURI_NATIVE_STORE_METHODS);
const nativeStoreMutates = (method) => !['load-profiles', 'load-settings', 'overlay-layout-load', 'overlay-layout-list-snapshot', 'stability-load', 'stability-list', 'stability-latest', 'update-release-select', 'update-check', 'temperature-refusal-cache-read', 'registry-apply-plan', 'game-load', 'game-load-catalog', 'game-has-catalog-path', 'recording-load', 'recording-settings', 'recording-list-clips', 'recording-list-markers', 'recording-clip-by-id', 'fan-resume-list', 'fan-resume-get', 'window-state-load', 'window-state-restore', 'obs-credential-load', 'rtss-profile-state', 'rtss-frame-limit-get', 'rtss-frame-limit-ownership'].includes(method);
const windowActions = new Set(['create', 'showInactive', 'setAlwaysOnTop', 'setIgnoreMouseEvents', 'setBackgroundColor', 'setSkipTaskbar', 'show', 'hide', 'focus', 'minimize', 'maximize', 'unmaximize', 'restore', 'close', 'destroy', 'setBounds', 'setTitle', 'setProgress']);
const hostEvents = new Set(['console-message', 'ready', 'show', 'hide', 'focus', 'blur', 'minimize', 'restore', 'maximized-changed', 'bounds-changed', 'close', 'closed', 'did-start-loading', 'did-finish-load', 'will-navigate', 'render-process-gone', 'destroyed', 'telemetry-sample', 'telemetry-target', 'shortcut', 'power', 'tray-action', 'recording-state', 'recording-action-result', 'recording-status-pill-owner-ready', 'recording-status-pill-owner-unavailable', 'settings-cache', 'startup-update-decision']);
function exact(o, keys) { return o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k)); }
function jsonDepth(value, depth = 0) {
  // Tagged wire adds structural nodes. Semantic wire depth is checked by its codec.
  if (depth > 260) throw new Error('Frame nesting limit exceeded');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe frame key');
    jsonDepth(child, depth + 1);
  }
}
function plainJson(value, depth = 0) {
  if (depth > 64) throw new Error('JSON nesting limit exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Expected plain JSON');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in descriptor)) throw new Error('Unsafe JSON key');
    plainJson(descriptor.value, depth + 1);
  }
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Unsupported JSON symbol');
}
export function createTauriBroker({ token = process.env.ARC_POWER_TAURI_SESSION, input = process.stdin, output = process.stdout, invoke, invokePrivate = null, getAllowedChannels, getPrivateChannels = () => [], onHostWindowEvent = () => {}, onMediaRequest, onClose = () => {}, maxInFlight = 128, maxQueuedBytes = 16 * 1024 * 1024, nativeStoreTimeoutMs = 30_000 } = {}) {
  if (typeof token !== 'string' || token.length < 32 || typeof invoke !== 'function' || typeof getAllowedChannels !== 'function') throw new TypeError('Broker requires a private session and dispatcher');
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new TypeError('Invalid broker in-flight limit');
  if (!Number.isFinite(nativeStoreTimeoutMs) || nativeStoreTimeoutMs < 1 || nativeStoreTimeoutMs > 30_000) throw new TypeError('Invalid native store timeout');
  const secret = Buffer.from(token);
  let started = false, closed = false, accepting = true, pendingLine = '', queuedBytes = 0;
  let shutdownRequested = false;
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  const nativeStorePending = new Map();
  // A timed-out request may still finish in the host. Retain bounded IDs so
  // its single validated late reply does not terminate the service session.
  const nativeStoreTimedOut = new Set();
  let lastNativeStoreId = 0;
  const requestContext = new AsyncLocalStorage();
  let lastId = 0;
  let writes = Promise.resolve();
  function close(reason = 'closed') {
    if (closed) return;
    closed = true; accepting = false;
    pendingLine = '';
    input.off('data', read); input.off('end', ended); input.off('error', failed);
    for (const request of nativeStorePending.values()) {
      clearTimeout(request.timer);
      request.reject(nativeStoreFailure(request.method, `connection closed (${reason})`));
    }
    nativeStorePending.clear();
    nativeStoreTimedOut.clear();
    // Keep the error listener on the output: late asynchronous errors must not crash Node.
    try { onClose(reason); } catch { /* transport close must remain idempotent */ }
  }
  function send(body) {
    if (closed) return Promise.reject(new Error('Broker closed'));
    let line;
    try { line = `${TAURI_RPC_PREFIX}${JSON.stringify({ v: 1, session: token, ...body })}\n`; }
    catch (error) { return Promise.reject(error); }
    const size = Buffer.byteLength(line);
    if (size > TAURI_RPC_MAX_FRAME_BYTES || queuedBytes + size > maxQueuedBytes) {
      close('output limit exceeded'); return Promise.reject(new Error('Broker output limit exceeded'));
    }
    queuedBytes += size;
    const task = writes.then(() => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Broker closed'));
      // Write callbacks serialize frames and honor stream backpressure without replay.
      output.write(line, (error) => error ? reject(error) : resolve());
    })).finally(() => { queuedBytes -= size; });
    writes = task.catch(() => { close('output failed'); });
    return task;
  }
  function authenticated(frame) {
    if (typeof frame?.session !== 'string') return false;
    const supplied = Buffer.from(frame.session);
    return supplied.length === secret.length && timingSafeEqual(secret, supplied);
  }
  function nativeStoreFailure(method, reason) {
    const mutation = nativeStoreMutates(method);
    const error = new Error(`Native store ${reason}${mutation ? '; mutation outcome unknown' : ''}`);
    error.code = mutation ? 'NATIVE_STORE_OUTCOME_UNKNOWN' : 'NATIVE_STORE_UNAVAILABLE';
    return error;
  }
  async function requestNativeStore(method, args, { timeoutMs = nativeStoreTimeoutMs } = {}) {
    if (!nativeStoreMethods.has(method)) throw new TypeError('Unknown native store method');
    if (!Array.isArray(args)) throw new TypeError('Native store arguments must be an array');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000
      || (timeoutMs > nativeStoreTimeoutMs && method !== 'update-download')) {
      throw new TypeError('Invalid native store timeout');
    }
    if (closed) throw new Error('Broker closed');
    if (nativeStorePending.size >= 128) throw new Error('Native store request limit exceeded');
    if (lastNativeStoreId >= Number.MAX_SAFE_INTEGER) throw new Error('Native store request IDs exhausted');
    const encoded = encodeTauriWire(args);
    const id = ++lastNativeStoreId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        nativeStorePending.delete(id);
        nativeStoreTimedOut.add(id);
        if (nativeStoreTimedOut.size > 128) nativeStoreTimedOut.delete(nativeStoreTimedOut.values().next().value);
        reject(nativeStoreFailure(method, 'request timed out'));
      }, timeoutMs);
      nativeStorePending.set(id, { method, resolve, reject, timer });
      void send({ kind: 'native-store-request', id, method, args: encoded }).catch(() => {
        const request = nativeStorePending.get(id);
        if (!request) return;
        nativeStorePending.delete(id);
        clearTimeout(request.timer);
        request.reject(nativeStoreFailure(method, 'request could not be delivered'));
      });
    });
  }
  async function handle(line) {
    if (!line.startsWith(TAURI_RPC_PREFIX)) throw new Error('Invalid frame prefix');
    const frame = JSON.parse(line.slice(TAURI_RPC_PREFIX.length));
    jsonDepth(frame);
    if (frame?.v !== 1 || !authenticated(frame)) throw new Error('Invalid broker session');
    // Reverse store replies use a separate ID space. They must never change
    // renderer-invoke replay state or be interpreted as renderer authority.
    if (frame.kind === 'native-store-response') {
      if (typeof frame.ok !== 'boolean' || !Number.isSafeInteger(frame.id) || frame.id < 1
        || !exact(frame, frame.ok ? ['v', 'session', 'kind', 'id', 'ok', 'value'] : ['v', 'session', 'kind', 'id', 'ok', 'error'])) throw new Error('Invalid native store response');
      let value;
      if (frame.ok) value = decodeTauriWire(frame.value);
      else if (!exact(frame.error, ['message']) || typeof frame.error.message !== 'string') throw new Error('Invalid native store error');
      if (!nativeStorePending.has(frame.id)) {
        // Validate before discard. Consuming the tombstone rejects duplicate
        // responses, and never changes the already reported unknown outcome.
        if (nativeStoreTimedOut.delete(frame.id)) return;
        throw new Error('Invalid native store response');
      }
      const request = nativeStorePending.get(frame.id);
      nativeStorePending.delete(frame.id);
      clearTimeout(request.timer);
      if (frame.ok) request.resolve(value);
      else request.reject(new Error(frame.error.message));
      return;
    }
    if (frame.kind === 'shutdown') {
      if (!exact(frame, ['v', 'session', 'kind'])) throw new Error('Invalid shutdown frame');
      accepting = false;
      if (!shutdownRequested) {
        shutdownRequested = true;
        onClose('host requested shutdown');
      }
      return;
    }
    if (frame.kind === 'host-event') {
      if (!exact(frame, ['v', 'session', 'kind', 'event', 'payload', 'target']) || !hostEvents.has(frame.event)
        || !tauriWindowRole(frame.target ?? 'main')) throw new Error('Invalid host window event');
      plainJson(frame.payload ?? {});
      await onHostWindowEvent(frame.event, frame.payload ?? {}, frame.target ?? 'main'); return;
    }
    const media = frame.kind === 'media';
    if (!exact(frame, media ? ['v', 'session', 'id', 'kind', 'request', 'target'] : ['v', 'session', 'id', 'kind', 'channel', 'args', 'target']) || (!media && frame.kind !== 'invoke')
      || (media && (frame.target ?? 'main') !== 'main')
      || (!media && !tauriWindowRole(frame.target ?? 'main'))
      || !Number.isSafeInteger(frame.id) || frame.id < 1 || frame.id <= lastId
      || (!media && typeof frame.channel !== 'string')) throw new Error('Invalid invoke frame');
    // Monotonic IDs bound replay protection storage for arbitrarily long sessions.
    lastId = frame.id;
    if (!accepting || pending.size >= maxInFlight) throw new Error('Broker is not accepting requests');
    let args;
    if (media) {
      if (typeof onMediaRequest !== 'function' || !exact(frame.request, ['url', 'method', 'headers'])
        || typeof frame.request.url !== 'string' || !['GET', 'HEAD'].includes(frame.request.method)
        || !exact(frame.request.headers, ['range']) || (frame.request.headers.range !== undefined && typeof frame.request.headers.range !== 'string')) throw new Error('Invalid media request');
    } else {
      const privateChannel = new Set(getPrivateChannels()).has(frame.channel);
      if (privateChannel && (frame.target ?? 'main') !== 'main') throw new Error('Private broker operation is restricted to the native host');
      if (!privateChannel && !new Set(getAllowedChannels()).has(frame.channel)) throw new Error('Unknown invoke channel');
      if (privateChannel && typeof invokePrivate !== 'function') throw new Error('Private broker operations are unavailable');
      args = decodeTauriWire(frame.args);
      if (!Array.isArray(args)) throw new Error('Invoke arguments must be an array');
    }
    const privateChannel = !media && new Set(getPrivateChannels()).has(frame.channel);
    const task = Promise.resolve().then(() => requestContext.run(frame.id, () => media
      ? onMediaRequest(frame.request)
      : privateChannel
        ? invokePrivate(frame.channel, args, frame.target ?? 'main')
        : invoke(frame.channel, args, frame.target ?? 'main'))).then(
      (value) => send({ id: frame.id, kind: 'response', ok: true, value: media ? value : encodeTauriWire(value) }),
      (error) => send({ id: frame.id, kind: 'response', ok: false, error: { message: error instanceof Error ? error.message : String(error) } }),
    );
    pending.set(frame.id, task);
    void task.catch(() => close('response failed')).finally(() => pending.delete(frame.id));
  }
  function read(chunk) {
    if (closed) return;
    pendingLine += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let index;
    while ((index = pendingLine.indexOf('\n')) !== -1) {
      const line = pendingLine.slice(0, index).replace(/\r$/, ''); pendingLine = pendingLine.slice(index + 1);
      if (Buffer.byteLength(line) > TAURI_RPC_MAX_FRAME_BYTES) { close('input limit exceeded'); return; }
      void handle(line).catch(() => close('invalid input'));
      if (closed) return;
    }
    if (Buffer.byteLength(pendingLine) > TAURI_RPC_MAX_FRAME_BYTES) close('input limit exceeded');
  }
  function ended() { close('input ended'); }
  function failed(error) { close(`stream failed${typeof error?.code === 'string' ? `: ${error.code}` : ''}`); }
  return {
    start() {
      if (started || closed) return;
      started = true; input.on('data', read); input.on('end', ended); input.on('error', failed); output.on('error', failed);
    },
    ready: ({ phase = 'services' } = {}) => {
      if (!['splash', 'initializing', 'services'].includes(phase)) return Promise.reject(new Error('Invalid readiness phase'));
      return send({ kind: 'ready', phase, channels: [...new Set(getAllowedChannels())] });
    },
    emitToMain: (channel, ...args) => send({ kind: 'event', target: 'main', channel, args: encodeTauriWire(args) }),
    emitToWindow: (target, channel, ...args) => {
      if (!tauriWindowRole(target)) return Promise.reject(new Error('Invalid event target'));
      return send({ kind: 'event', target, channel, args: encodeTauriWire(args) });
    },
    hostOperation(operation, args = {}) {
      if (!TAURI_HOST_OPERATIONS.includes(operation)) return Promise.reject(new Error('Unknown host operation'));
      if (operation === 'window' && !windowActions.has(args?.action)) return Promise.reject(new Error('Unknown window action'));
      try { plainJson(args); } catch (error) { return Promise.reject(error); }
      return send({ kind: 'host-op', operation, args });
    },
    async drain({ timeoutMs = 15_000 } = {}) {
      accepting = false;
      const currentRequestId = requestContext.getStore();
      let timer;
      // Maintenance can invoke teardown from inside its own request. Its reply
      // cannot settle until teardown returns, so wait only for other requests.
      const done = async () => { await Promise.allSettled([...pending].filter(([id]) => id !== currentRequestId).map(([, task]) => task)); await writes; };
      try {
        await Promise.race([done(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Broker drain timed out; mutation outcome may be indeterminate')), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
    close,
    requestNativeStore,
    get closed() { return closed; },
    get inFlight() { return pending.size; },
  };
}
