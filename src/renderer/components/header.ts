// Arc Power — GPU header: device name, driver version, health status dot,
// mock-mode badge. Rendered once, updated by store subscriptions.

import { el, clear } from '../dom.ts';
import type { Store } from '../router.ts';
import type { HealthReport } from '../types.ts';

export type StatusLevel = 'ok' | 'degraded' | 'error' | 'searching';

export function healthStatus(h: HealthReport | null): StatusLevel {
  if (!h) return 'searching'; // no health report yet — boot in progress
  if (h.error) return 'error';
  if (!h.igclLoaded || !h.levelZeroOk) return 'degraded';
  return 'ok';
}

export const STATUS_LABEL: Record<StatusLevel, string> = {
  ok: 'Healthy',
  degraded: 'Degraded',
  error: 'Error',
  searching: 'Searching…',
};

export class GpuHeader {
  private readonly mount: HTMLElement;
  private readonly store: Store;

  constructor(mount: HTMLElement, store: Store) {
    this.mount = mount;
    this.store = store;
    this.render();
  }

  render(): void {
    const s = this.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    const health = s.health;
    const status = healthStatus(health);
    const dot = el('span', { class: `status-dot status-${status}`, title: STATUS_LABEL[status] });
    clear(this.mount);
    this.mount.append(
      el('div', { class: 'gpu-header' }, [
        el('div', { class: 'gpu-identity' }, [
          el('div', { class: 'gpu-name', text: device?.name ?? (s.bootError ? 'No GPU detected' : 'Arc Power') }),
          device
            ? el('div', { class: 'gpu-meta', text: `Driver ${device.driverVersion} · PCI ${device.pciVendorId}:${device.pciDeviceId}` })
            : el('div', { class: 'gpu-meta', text: s.bootError ?? 'Searching for a graphics device…' }),
        ]),
        el('div', { class: 'gpu-status' }, [
          health?.backend === 'mock' ? el('span', { class: 'badge badge-mock', text: 'Mock mode' }) : null,
          el('span', { class: 'gpu-status-text', text: STATUS_LABEL[status] }, [dot]),
        ]),
      ]),
    );
  }
}
