// Arc Power — hash router + app-wide state store.

import type {
  Capabilities,
  DeviceInfo,
  DeviceState,
  FeaturesetInfo,
  HealthReport,
  LastApply,
  RegistryCatalogResponse,
  SysInfo,
  TelemetrySample,
} from './types.ts';

export type PageId = 'dashboard' | 'overclocking' | 'fan' | 'monitoring' | 'profiles' | 'tweaks' | 'settings';

export const PAGE_IDS: PageId[] = ['dashboard', 'overclocking', 'fan', 'monitoring', 'profiles', 'tweaks', 'settings'];

export const NAV_LABELS: Record<PageId, string> = {
  dashboard: 'Dashboard',
  overclocking: 'Overclocking',
  fan: 'Fan',
  monitoring: 'Monitoring',
  profiles: 'Profiles',
  tweaks: 'Tweaks',
  // M4-D: the Settings tab (Start with Windows / Start minimized / About).
  settings: 'Settings',
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
  /** M3-A: the last OC apply outcome (dashboard "OC working" health row). */
  lastApply: LastApply | null;
  /** Display-driver registry date ("7-5-2026") from the driver-info IPC. */
  driverDate: string | null;
  /** M2C-B B3: app version for the header line (app:version IPC). */
  appVersion: string;
  /** M3-C: this process runs as administrator (app-elevated IPC). */
  elevated: boolean;
  /** M3-C: applies go through the elevated self-worker (UAC prompt) —
   *  the elevation toast fires before the apply when true. */
  workerApply: boolean;
  /** M3-C-E: the OC mode (stock|advanced) — which ranges getCapabilities
   *  exposes and the apply gate's mode. Fetched at boot via oc-mode-get. */
  ocMode: 'stock' | 'advanced';
  bootError: string | null;
  /** M2D (mock mode only): the mock featureset list + active selection for
   *  the header dropdown. Empty in real mode (no dropdown, no channel). */
  featuresets: FeaturesetInfo[];
  featuresetId: string | null;
  /** M3-A: the registry-hacks catalog + live read states (Tweaks page).
   *  Null until the first fetch (page shows 'Loading…'); a failed fetch
   *  degrades to an empty response so the page renders the error note. */
  catalog: RegistryCatalogResponse | null;
  /** M4-D: the system-info payload (dashboard CPU & memory card). Null until
   *  the boot fetch lands (the card then re-renders via the sig). */
  sysinfo: SysInfo | null;
}

const INITIAL: AppState = {
  health: null,
  devices: [],
  deviceId: null,
  caps: null,
  state: null,
  latestSample: null,
  lastApply: null,
  driverDate: null,
  appVersion: '0.0.0',
  elevated: false,
  workerApply: false,
  ocMode: 'stock',
  bootError: null,
  featuresets: [],
  featuresetId: null,
  catalog: null,
  sysinfo: null,
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
