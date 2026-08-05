// Arc Power — hash router + app-wide state store.

import type { Capabilities, DeviceInfo, DeviceState, HealthReport, TelemetrySample } from './types.ts';

export type PageId = 'dashboard' | 'overclocking' | 'fan' | 'monitoring' | 'profiles' | 'tweaks';

export const PAGE_IDS: PageId[] = ['dashboard', 'overclocking', 'fan', 'monitoring', 'profiles', 'tweaks'];

export const NAV_LABELS: Record<PageId, string> = {
  dashboard: 'Dashboard',
  overclocking: 'Overclocking',
  fan: 'Fan',
  monitoring: 'Monitoring',
  profiles: 'Profiles',
  tweaks: 'Tweaks',
};

export function pageFromHash(hash: string): PageId {
  const id = hash.replace(/^#\/?/, '').split('?')[0] as PageId;
  return PAGE_IDS.includes(id) ? id : 'dashboard';
}

export function currentPage(): PageId {
  return pageFromHash(window.location.hash);
}

// ---------------------------------------------------------------------------
// Page contract
// ---------------------------------------------------------------------------

export interface PageContext {
  store: Store;
}

export interface Page {
  id: PageId;
  /** Full render into the page container (called on navigation). */
  render(container: HTMLElement, ctx: PageContext): void;
  /** Lightweight refresh on store changes (telemetry ticks etc.). */
  onUpdate?(container: HTMLElement, ctx: PageContext): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AppState {
  health: HealthReport | null;
  devices: DeviceInfo[];
  deviceId: number | null;
  caps: Capabilities | null;
  state: DeviceState | null;
  latestSample: TelemetrySample | null;
  bootError: string | null;
}

const INITIAL: AppState = {
  health: null,
  devices: [],
  deviceId: null,
  caps: null,
  state: null,
  latestSample: null,
  bootError: null,
};

export class Store {
  private data: AppState = { ...INITIAL };
  private cbs = new Set<() => void>();

  get(): AppState {
    return this.data;
  }

  set(patch: Partial<AppState>): void {
    this.data = { ...this.data, ...patch };
    for (const cb of this.cbs) {
      try { cb(); } catch { /* subscriber errors must not break the loop */ }
    }
  }

  subscribe(cb: () => void): () => void {
    this.cbs.add(cb);
    return () => { this.cbs.delete(cb); };
  }
}
