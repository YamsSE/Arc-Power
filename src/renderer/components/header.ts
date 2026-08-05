// Arc Power — GPU header: device name, app version line, health status dot,
// mock-mode badge. Rendered once, updated by store subscriptions.
//
// M2b-B dashboard redesign:
//   - the driver line moved OUT of the header (M2C-B B3): the line below the
//     GPU name is now "Arc Power Ver. X.XX" (the app version via the
//     `app:version` IPC); the driver version + registry date stay in the
//     dashboard device card ('Driver version' kv, driver-info IPC);
//   - PCI ID is gone;
//   - the top-right indicator is just the colored dot + the static
//     "Service Status" label (the verbose IGS text moved into the dot's
//     tooltip and the dashboard's merged status card).
//
// The status mapping (health + IGS service -> level + label) lives in
// pure/status.ts and is shared with the dashboard; this module re-exports
// the legacy health-only surface (healthStatus / STATUS_LABEL) so existing
// import sites and tests keep working. driverLine (driver version + date)
// is kept here for the dashboard device card.

import { el, clear } from '../dom.ts';
import type { Store } from '../router.ts';
import { mapStatus, STATUS_LABEL } from '../pure/status.ts';
import { decodeDriverVersion, formatDriverDate } from '../pure/driver.ts';

export { STATUS_LABEL };
export { healthLevel as healthStatus } from '../pure/status.ts';
export type { StatusLevel } from '../pure/status.ts';

/** M2b-B: the static label next to the status dot (pinned by --ui-verify). */
export const SERVICE_STATUS_LABEL = 'Service Status';

/** M2C-B B3: the header line below the GPU name. */
export function versionLine(version: string | null | undefined): string {
  return `Arc Power Ver. ${version && version.length > 0 ? version : '0.0.0'}`;
}

/**
 * The driver line (dotted version + optional registry date,
 * "32.0.101.8861 - Jul 05, 2026") for the dashboard device card. Null when
 * nothing is known yet.
 */
export function driverLine(device: { driverVersion: string } | null | undefined, driverDate: string | null): string | null {
  if (!device) return null;
  const version = decodeDriverVersion(device.driverVersion);
  if (!version) return null;
  const date = formatDriverDate(driverDate);
  return date ? `${version} - ${date}` : version;
}

export class GpuHeader {
  private readonly mount: HTMLElement;
  private readonly store: Store;
  private readonly onFeaturesetSwap: ((id: string) => void) | undefined;

  constructor(mount: HTMLElement, store: Store, opts: { onFeaturesetSwap?: (id: string) => void } = {}) {
    this.mount = mount;
    this.store = store;
    this.onFeaturesetSwap = opts.onFeaturesetSwap;
    this.render();
  }

  render(): void {
    const s = this.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    const health = s.health;
    const { level, label } = mapStatus(health, s.igsState);
    const dot = el('span', { class: `status-dot status-${level}`, title: label });
    // M2D: the featureset dropdown — mock mode only (empty list in real mode
    // because the store only fills it from the mock-only IPC).
    const mockBadge = health?.backend === 'mock' ? el('span', { class: 'badge badge-mock', text: 'Mock mode' }) : null;
    const fsSelect = health?.backend === 'mock' && s.featuresets.length > 0
      ? el('select', {
          class: 'featureset-select',
          title: 'Mock device featureset (dev only)',
          onchange: (e: Event) => {
            const id = (e.target as HTMLSelectElement).value;
            void this.onFeaturesetSwap?.(id);
          },
        }, s.featuresets.map((f) => {
          const opt = el('option', { value: f.id, text: `${f.id} · ${f.name}` });
          if (f.id === s.featuresetId) opt.selected = true;
          return opt;
        }))
      : null;
    clear(this.mount);
    this.mount.append(
      el('div', { class: 'gpu-header' }, [
        el('div', { class: 'gpu-identity' }, [
          el('div', { class: 'gpu-name', text: device?.name ?? (s.bootError ? 'No GPU detected' : 'Arc Power') }),
          el('div', { class: 'gpu-meta', text: s.bootError ?? versionLine(s.appVersion) }),
        ]),
        el('div', { class: 'gpu-status' }, [
          fsSelect,
          mockBadge,
          el('span', { class: 'gpu-status-text' }, [dot, el('span', { class: 'gpu-status-label', text: SERVICE_STATUS_LABEL })]),
        ]),
      ]),
    );
  }
}
