import { EventEmitter } from 'node:events';
import path from 'node:path';
import { SOFTWARE_THEMES } from './theme.js';
let nextId = 1_000_000;
const validBounds = (b) => b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;
const roles = new Set(['main', 'overlay', 'advanced-overlay', 'recording-toast', 'recording-status-pill', 'splash']);

/** Window identity and event adapter; native document creation is host-owned. */
export class TauriWindowProxy extends EventEmitter {
  constructor({ sendHostOperation, emitToMain, bounds = { x: 0, y: 0, width: 1280, height: 820 }, show = false, title = 'Arc Power', hostProcessId = 0, onError = () => {}, target = 'main', role = 'main', loadDocument } = {}) {
    super();
    if (typeof sendHostOperation !== 'function' || typeof emitToMain !== 'function' || !validBounds(bounds)) throw new TypeError('Window proxy requires host adapters and bounds');
    if (!roles.has(role) || (role === 'main' ? target !== 'main' : typeof target !== 'string' || !new RegExp(`^${role}-[1-9][0-9]*$`).test(target))) throw new TypeError('Invalid window role or target');
    if (loadDocument !== undefined && typeof loadDocument !== 'function') throw new TypeError('Invalid document loader');
    this.id = nextId++; this._send = sendHostOperation; this._emit = emitToMain; this._onError = onError;
    this.target = target; this.role = role; this._loadDocument = loadDocument; this._loading = role !== 'main'; this._documentLoad = null;
    this._bounds = { ...bounds }; this._normalBounds = { ...bounds }; this._visible = show; this._title = title;
    this._destroyed = false; this._maximized = false; this._minimized = false; this._focused = false;
    this.webContents = new EventEmitter();
    this.webContents.id = this.id;
    this.webContents.mainFrame = Object.freeze({ routingId: this.id });
    this.webContents.send = (channel, ...args) => { if (!this._destroyed) this._run(() => this._emit(channel, ...args)); };
    this.webContents.isDestroyed = () => this._destroyed;
    this.webContents.isLoading = () => this._loading === true;
    this.webContents.getOSProcessId = () => Number.isInteger(hostProcessId) && hostProcessId > 0 ? hostProcessId : 0;
  }
  _run(fn) { try { Promise.resolve(fn()).catch(this._onError); } catch (error) { this._onError(error); } }
  _op(action, fields = {}) { if (!this._destroyed) this._run(() => this._send('window', { action, ...fields, ...(this.target === 'main' ? {} : { target: this.target }) })); }
  trustedEvent() { return { sender: this.webContents, senderFrame: this.webContents.mainFrame }; }
  isDestroyed() { return this._destroyed; }
  isVisible() { return this._visible; }
  isMaximized() { return this._maximized; }
  isMinimized() { return this._minimized; }
  isFocused() { return this._focused; }
  getBounds() { return { ...this._bounds }; }
  getNormalBounds() { return { ...this._normalBounds }; }
  getTitle() { return this._title; }
  show() { this._op('show'); }
  showInactive() { this._op('showInactive'); }
  hide() { this._op('hide'); }
  focus() { this._op('focus'); }
  minimize() { this._op('minimize'); }
  maximize() { this._op('maximize'); }
  unmaximize() { this._op('unmaximize'); }
  restore() { this._op('restore'); }
  setBounds(bounds) { if (!validBounds(bounds)) throw new TypeError('Invalid window bounds'); this._op('setBounds', { bounds }); }
  setTitle(title) { if (typeof title !== 'string') throw new TypeError('Invalid window title'); this._title = title; this._op('setTitle', { title }); }
  setProgressBar(progress) { if (!Number.isFinite(progress)) throw new TypeError('Invalid progress'); this._op('setProgress', { progress }); }
  setAlwaysOnTop(value, level = 'normal') {
    if (typeof value !== 'boolean' || !['normal', 'floating', 'screen-saver'].includes(level)) throw new TypeError('Invalid always-on-top state');
    this._op('setAlwaysOnTop', { value, level });
  }
  setIgnoreMouseEvents(value, options = {}) {
    if (typeof value !== 'boolean' || !options || typeof options !== 'object' || Object.keys(options).some((key) => key !== 'forward') || (options.forward !== undefined && typeof options.forward !== 'boolean')) throw new TypeError('Invalid mouse-event state');
    this._op('setIgnoreMouseEvents', { value, forward: options.forward === true });
  }
  setBackgroundColor(color) {
    if (typeof color !== 'string' || !/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) throw new TypeError('Invalid background color');
    this._op('setBackgroundColor', { color });
  }
  setSkipTaskbar(value) { if (typeof value !== 'boolean') throw new TypeError('Invalid taskbar state'); this._op('setSkipTaskbar', { value }); }
  // Native hosts install the fixed product icon; NativeImage never crosses RPC.
  setIcon() {}
  loadFile(file, options = {}) {
    let resolveLoad, rejectLoad;
    const promise = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
    // Several existing controllers intentionally use fire-and-forget loadFile.
    // Preserve a rejecting Promise for awaiters without unhandled rejections.
    void promise.catch(() => {});
    try {
      const document = this.role === 'main' ? 'index.html' : `${this.role}.html`;
      if (typeof file !== 'string' || path.basename(file) !== document || !options || typeof options !== 'object' || Object.keys(options).some((key) => key !== 'query')) throw new TypeError('Invalid role document');
      const query = options.query ?? {};
      if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => key !== 'theme') || (query.theme !== undefined && !SOFTWARE_THEMES.includes(query.theme))) throw new TypeError('Invalid document query');
      if (this._destroyed) throw new Error('Window is destroyed');
      if (!this._loadDocument) throw new Error('Window has no document loader');
      if (this._documentLoad) throw new Error('Window document is already loading');
      this._loading = true;
      this._documentLoad = { resolve: resolveLoad, reject: rejectLoad };
      Promise.resolve(this._loadDocument({ role: this.role, query: { ...query } })).catch((error) => this._settleDocument(error));
    } catch (error) {
      if (this._documentLoad?.reject === rejectLoad) this._settleDocument(error);
      else rejectLoad(error);
    }
    return promise;
  }
  _settleDocument(error) {
    const pending = this._documentLoad; this._documentLoad = null;
    if (pending) { if (error) { this._loading = false; pending.reject(error); } else pending.resolve(); }
  }
  close() {
    if (this._destroyed) return;
    let prevented = false;
    this.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy() {
    if (this._destroyed) return;
    this._op('destroy'); this._destroyed = true; this._visible = false; this._loading = false;
    this._settleDocument(new Error('Window destroyed before document was ready'));
    this.webContents.emit('destroyed'); this.emit('closed');
  }
  receiveHostEvent(event, payload = {}) {
    if (this._destroyed) return;
    if (event === 'close') { this.close(); return; }
    // Auxiliary readiness is announced after the preload subscribes. A raw
    // navigation completion must not release queued settings before then.
    if (event === 'did-finish-load' && this.target !== 'main') return;
    if (event === 'ready') { this._loading = false; this._settleDocument(); this.webContents.emit('did-finish-load'); this.emit('ready-to-show'); return; }
    if (event === 'did-fail-load') { this._loading = false; this._settleDocument(new Error(payload.errorDescription || 'Native document failed to load')); this.webContents.emit(event, payload); return; }
    if (event === 'destroyed' && this.target !== 'main') {
      this._destroyed = true; this._visible = false; this._loading = false; this._settleDocument(new Error('Window destroyed before document was ready'));
      this.webContents.emit('destroyed'); this.emit('closed'); return;
    }
    if (event === 'maximized-changed') {
      if (typeof payload.maximized !== 'boolean') throw new TypeError('Invalid maximized state');
      if (this._maximized !== payload.maximized) { this._maximized = payload.maximized; this.emit(this._maximized ? 'maximize' : 'unmaximize'); }
      return;
    }
    if (event === 'bounds-changed') {
      if (!validBounds(payload.bounds)) throw new TypeError('Invalid host bounds');
      const old = this._bounds; this._bounds = { ...payload.bounds };
      if (!this._maximized && !this._minimized) this._normalBounds = { ...payload.bounds };
      if (old.x !== this._bounds.x || old.y !== this._bounds.y) this.emit('move');
      if (old.width !== this._bounds.width || old.height !== this._bounds.height) this.emit('resize');
      return;
    }
    if (event === 'show' || event === 'hide') this._visible = event === 'show';
    if (event === 'focus' || event === 'blur') this._focused = event === 'focus';
    if (event === 'minimize' || event === 'restore') this._minimized = event === 'minimize';
    if (['console-message', 'did-start-loading', 'will-navigate', 'render-process-gone', 'destroyed', 'did-finish-load'].includes(event)) {
      if (this.target === 'main' || event === 'did-start-loading') this._loading = event === 'did-start-loading';
      this.webContents.emit(event, payload);
    } else this.emit(event, payload);
  }
}
export const createTauriWindowProxy = (options) => new TauriWindowProxy(options);
