// The original sandbox preload is compiled against this transport. Its public
// methods, defaults, argument order and callbacks remain the source of truth.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
// @ts-expect-error JavaScript wire codec is shared with the compatibility broker.
import { encodeWire, decodeWire } from '../../shared/tauri-wire.js';
// @ts-expect-error Shared plain JavaScript adapter is tested independently.
import { adaptTauriMediaResult } from '../../shared/tauri-media-url.js';

type Listener = (event: unknown, ...args: unknown[]) => void;
type BrokerEvent = { channel: string; args: unknown };
const listeners = new Map<string, Set<Listener>>();
let stopEvents: UnlistenFn | null = null;
let stopFailures: UnlistenFn | null = null;

export async function initializeBridge(): Promise<void> {
  if (stopEvents) return;
  stopEvents = await listen<BrokerEvent>('arc-power:broker-event', ({ payload }) => {
    const args = decodeWire(payload.args);
    if (!Array.isArray(args)) return;
    for (const callback of [...(listeners.get(payload.channel) ?? [])]) {
      try { callback(Object.freeze({}), ...args); }
      catch (error) { console.error('[bridge] event callback failed', error); }
    }
  });
  stopFailures = await listen<string>('arc-power:broker-failed', ({ payload }) => {
    const failure = document.createElement('div');
    failure.setAttribute('role', 'alert');
    failure.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#101522;color:#f4f7ff;padding:32px;font:16px system-ui;white-space:pre-wrap';
    failure.textContent = `Arc Power lost its background service.\n${payload}\nClose and restart Arc Power before making further changes.`;
    document.body.append(failure);
  });
  window.addEventListener('unload', () => { stopEvents?.(); stopFailures?.(); stopEvents = null; listeners.clear(); }, { once: true });
}

export const contextBridge = {
  exposeInMainWorld(name: string, value: unknown): void {
    if (name !== 'arcPower' && name !== 'arcPowerSplash') throw new Error('Unexpected preload global');
    Object.defineProperty(window, name, { configurable: false, enumerable: true, writable: false, value: Object.freeze(value) });
  },
};

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    try { return adaptTauriMediaResult(channel, decodeWire(await invoke('bridge_invoke', { channel, args: encodeWire(args) }))); }
    catch (error) { throw error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error)); }
  },
  on(channel: string, listener: Listener): void {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(channel, set);
  },
  removeListener(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener);
  },
};

export async function rendererReady(): Promise<void> { await invoke('renderer_ready'); }
export async function rendererFailed(): Promise<void> { await invoke('renderer_failed'); }

export function installConsoleBridge(): void {
  for (const [name, level] of [['log', 0], ['warn', 2], ['error', 3]] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      if (typeof args[0] === 'string') void invoke('renderer_log', { level, message: args[0].slice(0, 16384) }).catch(() => {});
    };
  }
}

export function installDragRegions(): void {
  // Match current Electron drag zones without converting interactive descendants.
  const regions = '.titlebar-drag,.titlebar-brand,.titlebar-drag-right,.adv-header';
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (!event.target.closest(regions) || event.target.closest('button,input,select,textarea,a,[role="button"]')) return;
    event.preventDefault();
    void invoke('window_drag', { maximize: event.detail === 2 }).catch(console.error);
  });
}
