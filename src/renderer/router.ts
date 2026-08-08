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

export type PageId = 'dashboard' | 'tuning' | 'monitoring' | 'profiles' | 'tweaks' | 'settings';

export const PAGE_IDS: PageId[] = ['dashboard', 'tuning', 'monitoring', 'profiles', 'tweaks', 'settings'];

export const NAV_LABELS: Record<PageId, string> = {
  dashboard: 'Dashboard',
  // M4-D2 (§7): the Overclocking page was RENAMED to Tuning (the fan editor
  // moved into it as a sub-view — §8).
  tuning: 'Tuning',
  monitoring: 'Monitoring',
  profiles: 'Profiles',
  tweaks: 'Tweaks',
  // M4-D: the Settings tab (Start with Windows / Start minimized / About).
  settings: 'Settings',
};

// M4-D2 (§8): the old #/overclocking and #/fan hashes redirect to #/tuning
// (old bookmarks + old pins). The fan-view signal is a module flag: when
// the navigation arrived via #/fan, the Tuning page starts with the fan
// sub-view active (the hash itself is left in place — replaceState would
// destroy the signal before the page renders).
let fanViewRequested = false;

export function pageFromHash(hash: string): PageId {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  if (raw === 'fan') fanViewRequested = true;
  let id: string = raw;
  if (raw === 'overclocking' || raw === 'fan') id = 'tuning';
  return PAGE_IDS.includes(id as PageId) ? (id as PageId) : 'dashboard';
}

/** M4-D2: whether the current navigation arrived via the old #/fan alias —
 *  the Tuning page consumes this once at render to start with the fan
 *  sub-view active. */
export function consumeFanViewRequest(): boolean {
  const v = fanViewRequested;
  fanViewRequested = false;
  return v;
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
  /** M4-E: distribution kind (app:build-info IPC) — 'installed' | 'portable'
   *  | 'dev'; drives the Settings start-with-Windows hint text. */
  buildKind: 'installed' | 'portable' | 'dev';
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
  /** 1.0.1 no-Intel round: TRUE when the boot enumerated NO Intel GPU (the
   *  devices list was empty) — the app runs in the no-device mode (no
   *  caps/state, null-mode telemetry, honest no-Intel UI). */
  noIntel: boolean;
  /** 1.0.1 no-Intel round: the OS GPU (the sysinfo primary non-basic video
   *  controller — { name, vramBytes } | null). The header, the dashboard
   *  GPU card and the health rows read it; null while sysinfo has nothing. */
  osGpu: { name: string; vramBytes: number | null } | null;
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
  buildKind: 'dev',
  elevated: false,
  workerApply: false,
  ocMode: 'stock',
  bootError: null,
  featuresets: [],
  featuresetId: null,
  catalog: null,
  sysinfo: null,
  noIntel: false,
  osGpu: null,
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
