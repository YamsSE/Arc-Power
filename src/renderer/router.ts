// Arc Power — hash router + app-wide state store.

import type { Capabilities, DeviceInfo, DeviceState, FeaturesetInfo, HealthReport, IgsServiceState, TelemetrySample } from './types.ts';

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
  /**
   * Called by the router right before navigating away (M2b review F4):
   * pages that own timers/subscriptions stop them here so they never leak
   * onto other pages (e.g. Monitoring's 1 s FPS poll).
   */
  leave?(): void;
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
  igsState: IgsServiceState | null;
  /** Display-driver registry date ("7-5-2026") from the driver-info IPC. */
  driverDate: string | null;
  /** M2C-B B3: app version for the header line (app:version IPC). */
  appVersion: string;
  /** M2C-C: this process runs as administrator (app-elevated IPC). */
  elevated: boolean;
  /** M2C-C: applies go through the elevated self-worker (UAC prompt) —
   *  the elevation toast fires before the apply when true. */
  workerApply: boolean;
  bootError: string | null;
  /** M2D (mock mode only): the mock featureset list + active selection for
   *  the header dropdown. Empty in real mode (no dropdown, no channel). */
  featuresets: FeaturesetInfo[];
  featuresetId: string | null;
}

const INITIAL: AppState = {
  health: null,
  devices: [],
  deviceId: null,
  caps: null,
  state: null,
  latestSample: null,
  igsState: null,
  driverDate: null,
  appVersion: '0.0.0',
  elevated: false,
  workerApply: false,
  bootError: null,
  featuresets: [],
  featuresetId: null,
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
