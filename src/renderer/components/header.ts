// Arc Power — GPU header: device name, driver version, health status dot,
// mock-mode badge. Rendered once, updated by store subscriptions.
//
// The status mapping (health + IGS service -> level + label) lives in
// pure/status.ts and is shared with the dashboard; this module re-exports
// the legacy health-only surface (healthStatus / STATUS_LABEL) so existing
// import sites and tests keep working.

import { el, clear } from '../dom.ts';
import type { Store } from '../router.ts';
import { mapStatus, STATUS_LABEL } from '../pure/status.ts';

export { STATUS_LABEL };
export { healthLevel as healthStatus } from '../pure/status.ts';
export type { StatusLevel } from '../pure/status.ts';

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
    const { level, label } = mapStatus(health, s.igsState);
    const dot = el('span', { class: `status-dot status-${level}`, title: label });
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
          el('span', { class: 'gpu-status-text', text: label }, [dot]),
        ]),
      ]),
    );
  }
}
