// Arc Power - GPU header: device name, app version line, mock-mode badge,
// featureset dropdown (mock mode). Rendered once, updated by store
// subscriptions.
//
// M2b-B dashboard redesign:
//   - the driver line moved OUT of the header (M2C-B B3): the line below the
//     GPU name is now "Arc Power Ver. X.XX" (the app version via the
//     `app:version` IPC; the IPC keeps the bare semver; M5: displayVersion
//     renders the line - ' Beta' for the -beta.x line, nothing else (the
//     M11 "Alpha" scheme removal);
//     the driver version + registry date stay in the dashboard device card
//     ('Driver version' kv, driver-info IPC);
//   - PCI ID is gone;
//   - M3-A: the top-right status dot + "Service Status" label are REMOVED
//     (with the M2C-C elevation gate, IGS state is no longer relevant to
//     OC-applicability - the general GPU Status card on the dashboard
//     carries the status now). The header keeps the GPU name + version line
//     + the mock badge + the mock featureset dropdown.
//
// The health-only level mapping (healthLevel -> 'ok'/'warn'/'error'/'unknown')
// lives in pure/status.ts; this module re-exports the legacy healthStatus
// surface so existing import sites and tests keep working. driverLine
// (driver version + date) is kept here for the dashboard device card.

import { el, clear } from '../dom.ts';
import type { Store } from '../router.ts';
import { decodeDriverVersion, formatDriverDate } from '../pure/driver.ts';

export { healthLevel as healthStatus } from '../pure/status.ts';
export type { HealthLevel as StatusLevel } from '../pure/status.ts';

/** M2C-B B3: the header line below the GPU name. */
export function versionLine(version: string | null | undefined): string {
  return `Arc Power Ver. ${version && version.length > 0 ? version : '0.0.0'}`;
}

/**
 * M5: the DISPLAY version line - the semver WITHOUT the prerelease tag,
 * plus ' Beta' for a -beta.x version. M11: the "Alpha" naming scheme is
 * GONE - a stable release AND any other prerelease show NO suffix (the
 * app ships as the 1.0 Release -> 'Arc Power Ver. 1.0.0'; 1.0.0-rc.1 ->
 * 'Arc Power Ver. 1.0.0'). The app:version IPC keeps the BARE semver -
 * the display suffix is a renderer concern. Degraded/missing version
 * falls back to 0.0.0 (a bare stable - no suffix - never an empty line).
 */
export function displayVersion(version: string | null | undefined): string {
  const raw = version && version.length > 0 ? version : '0.0.0';
  const beta = /^(.*?)-beta\.\d+$/i.exec(raw);
  if (beta) return `Arc Power Ver. ${beta[1]} Beta`;
  return `Arc Power Ver. ${raw.replace(/-[^-]*$/, '')}`;
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
    const osOnly = device?.synthetic === true && device.backendKind === 'os';
    const noIntelPresentation = s.noIntel || osOnly;
    const health = s.health;
    // 1.0.1 no-Intel round (m5): the featureset dropdown is HIDDEN in the
    // no-device mode (mock mode) - the swap would store caps/state into the
    // no-Intel store and break the presentation (it is also a no-op in
    // app.ts). The mock badge stays (it reports the honest backend kind).
    const mockBadge = health?.backend === 'mock' ? el('span', { class: 'badge badge-mock', text: 'Mock mode' }) : null;
    const fsSelect = health?.backend === 'mock' && !noIntelPresentation && s.featuresets.length > 0
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
    // 1.0.1 no-Intel round: the header shows the OS GPU (sysinfo primary
    // controller) with 'Non supported GPU' REPLACING the version line (n10
    // - the exact ask); while the OS GPU is unknown the name reads
    // '-' (only 'No GPU detected' when sysinfo has nothing at all). M30:
    // selected synthetic OS-only rows use the same read-only presentation
    // while the machine still has an Intel-capable row available.
    const gpuName = noIntelPresentation
      ? (s.osGpu?.name ?? (s.sysinfo?.videoControllers?.length ? '-' : 'No GPU detected'))
      : device?.name ?? (s.bootError ? 'No GPU detected' : 'Arc Power');
    // M25: the standalone "Arc Power Ver." tag is REMOVED - the version
    // now lives in the titlebar-left next to the corner icon. The gpu-meta
    // shows the boot error when present, otherwise empty.
    const gpuMeta = noIntelPresentation
      ? 'Non supported GPU'
      : s.bootError ?? '';
    clear(this.mount);
    this.mount.append(
      el('div', { class: 'gpu-header' }, [
        el('div', { class: 'gpu-identity' }, [
          el('div', { class: 'gpu-name', text: gpuName }),
          // M4-A/M5: the display label carries the release-stage suffix
          // (' Beta' for the -beta.x line only - the M11 "Alpha" scheme
          // removal: a stable release shows the plain version, e.g. the
          // 1.0 Release 'Arc Power Ver. 1.0.0'); the app:version IPC keeps
          // the bare semver (test/ipc-core pins the package.json version).
          el('div', { class: 'gpu-meta', text: gpuMeta }),
        ]),
        el('div', { class: 'gpu-status' }, [fsSelect, mockBadge]),
      ]),
    );
  }
}
