// Arc Power — renderer bootstrap: boot sequence (health -> devices -> caps
// -> state -> telemetry), shell render (sidebar + GPU header + page), and
// hash routing.

import { api } from './ipc.ts';
import { el, clear } from './dom.ts';
import { Store, currentPage, NAV_LABELS, PAGE_IDS } from './router.ts';
import type { Page, PageId } from './router.ts';
import { GpuHeader } from './components/header.ts';
import { toast } from './components/toast.ts';
import { promptWaiverAtBoot } from './components/waiver-dialog.ts';
import { dashboardPage } from './pages/dashboard.ts';
import { overclockingPage } from './pages/overclocking.ts';
import { fanPage } from './pages/fan.ts';
import { monitoringPage } from './pages/monitoring.ts';
import { profilesPage } from './pages/profiles.ts';
import { tweaksPage } from './pages/tweaks.ts';

const PAGES: Record<PageId, Page> = {
  dashboard: dashboardPage,
  overclocking: overclockingPage,
  fan: fanPage,
  monitoring: monitoringPage,
  profiles: profilesPage,
  tweaks: tweaksPage,
};

const store = new Store();
const header = new GpuHeader(document.getElementById('gpu-header') as HTMLElement, store, {
  // M2D: the mock featureset swap re-reads caps + state + device + health in
  // main (one mock:set-featureset round trip) and re-renders the whole page
  // so ranges/units/controls/monitoring all update live. Mock mode only.
  onFeaturesetSwap: async (id: string) => {
    try {
      const out = await api.mockSetFeatureset(id);
      store.set({
        devices: out.devices,
        caps: out.caps,
        state: out.state,
        health: out.health,
        featuresetId: out.featureset.id,
        // M2D: the swap replaces the boot registry date with the featureset's
        // own (null when unverified) — the device card must never pair the
        // new driver version with the boot featureset's stale date.
        driverDate: out.driverDate ?? null,
      });
      renderPage(currentPage());
    } catch (err) {
      toast('error', 'Featureset swap failed', err instanceof Error ? err.message : String(err));
    }
  },
});
let current: Page | null = null;

function renderPage(id: PageId) {
  const container = document.getElementById('page') as HTMLElement;
  // M2b review F4: the page being left stops its timers/subscriptions
  // (e.g. Monitoring's FPS poll) before the next page renders.
  current?.leave?.();
  current = PAGES[id] ?? dashboardPage;
  try {
    current.render(container, { store });
  } catch (err) {
    clear(container);
    container.append(el('p', { class: 'text-error', text: `Page failed to render: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

function renderSidebar() {
  const nav = document.getElementById('sidebar') as HTMLElement;
  const active = currentPage();
  clear(nav);
  nav.append(
    // M3-A: the user's preferred variant — no logo image, just the "Arc
    // Power" text with the small blue accent bar below (the ::after bar in
    // styles.css). The window/EXE/tray/favicon icons (M2C-B B6) are kept.
    el('div', { class: 'sidebar-brand', text: 'Arc Power' }),
    el('nav', { class: 'sidebar-nav' }, PAGE_IDS.map((id) =>
      el('a', {
        class: `sidebar-link${id === active ? ' active' : ''}`,
        href: `#/${id}`,
        text: NAV_LABELS[id],
      }),
    )),
  );
}

async function boot() {
  store.subscribe(() => {
    header.render();
    if (current?.onUpdate) {
      const container = document.getElementById('page') as HTMLElement;
      try { current.onUpdate(container, { store }); } catch { /* keep UI alive */ }
    }
  });

  window.addEventListener('hashchange', () => {
    renderSidebar();
    renderPage(currentPage());
  });

  renderSidebar();
  renderPage(currentPage());

  // --- boot sequence -------------------------------------------------------
  let health;
  try {
    health = await api.health();
  } catch (err) {
    store.set({ bootError: `Health check failed: ${err instanceof Error ? err.message : String(err)}` });
    toast('error', 'Health check failed', err instanceof Error ? err.message : String(err));
    return;
  }
  store.set({ health });

  // M2D: in mock mode fill the featureset dropdown (the mock-only IPC; real
  // mode has no channel — the catch keeps the dropdown hidden).
  if (health.backend === 'mock') {
    try {
      const fx = await api.mockListFeaturesets();
      store.set({ featuresets: fx.featuresets, featuresetId: fx.current });
    } catch { /* the dropdown stays hidden */ }
  }

  let devices;
  try {
    devices = await api.listDevices();
  } catch (err) {
    store.set({ bootError: `Device enumeration failed: ${err instanceof Error ? err.message : String(err)}` });
    toast('error', 'No devices', err instanceof Error ? err.message : String(err));
    return;
  }
  store.set({ devices });
  if (devices.length === 0) {
    store.set({ bootError: 'No Intel Arc GPU detected. Install the driver or run with RID_BACKEND=mock to try the UI without hardware.' });
    return;
  }

  const deviceId = devices[0].id;
  store.set({ deviceId });

  // App version for the header line (M2C-B B3). Failure degrades to the
  // initial placeholder — the header stays up.
  try {
    const v = await api.appVersion();
    store.set({ appVersion: v?.version ?? '0.0.0' });
  } catch {
    store.set({ appVersion: '0.0.0' });
  }

  // Display-driver registry date (M2b-B, read-only): a lookup failure
  // degrades to null and the dashboard card shows the driver version alone.
  try {
    const info = await api.driverInfo();
    store.set({ driverDate: info?.driverDate ?? null });
  } catch {
    store.set({ driverDate: null });
  }

  // M3-A: the registry-hacks catalog (Tweaks page, read-side). Read-only
  // reg queries; a failure degrades to an empty catalog so the page can
  // render the error note. The IGS service probe is no longer surfaced as a
  // status item (igs-service.js stays for diagnostics + elevation helpers).
  try {
    const catalog = await api.registryCatalog();
    store.set({ catalog: catalog ?? { entries: [], states: [] } });
  } catch {
    store.set({ catalog: { entries: [], states: [] } });
  }

  // M2C-C elevation state (cached koffi probe — never spawns). Failure
  // degrades to not-elevated + no worker (the UI then behaves as a plain
  // elevated-in-process app — the apply either works or fails honestly).
  try {
    const e = await api.appElevated();
    store.set({ elevated: e?.elevated === true, workerApply: e?.workerApply === true });
  } catch {
    store.set({ elevated: false, workerApply: false });
  }

  // M3-C-E: the persisted OC mode (stock|advanced). Failure degrades to the
  // safe default ('stock' — main keeps its own default; the toggle re-syncs).
  try {
    const m = await api.ocModeGet();
    store.set({ ocMode: m?.ocMode === 'advanced' ? 'advanced' : 'stock' });
  } catch {
    store.set({ ocMode: 'stock' });
  }

  try {
    const caps = await api.getCapabilities(deviceId);
    const state = await api.getCurrentSettings(deviceId);
    store.set({ caps, state });
    // M4-B: the OC waiver prompt shows at EVERY startup (the user: "please
    // prompt it when the Program opens"). The driver-side waiver state
    // cannot be probed (IGCL exposes only ctlOverclockWaiverSet — no
    // getter), so the dialog at open is the only reliable visibility: an
    // in-session ACCEPTED waiver (persisted from an earlier session) shows
    // the dialog in its ACCEPTED state — a reminder with a single OK, never
    // a re-accept; an unaccepted session shows the classic Cancel/Accept
    // pair. NON-BLOCKING: the boot sequence continues; a declined prompt
    // must not break it. Accept patches the store caps so the dashboard GPU
    // Health card row flips to Accepted in place (the waiver pill is gone —
    // the health row is the only persistent waiver display).
    void (async () => {
      const decision = await promptWaiverAtBoot(deviceId, caps.waiverAccepted === true, caps.deviceName || 'this GPU');
      if (decision !== 'accepted') return;
      const live = store.get();
      if (live.caps && live.caps.waiverAccepted !== true) {
        store.set({ caps: { ...live.caps, waiverAccepted: true } });
      }
    })();
  } catch (err) {
    store.set({ bootError: `Could not read device state: ${err instanceof Error ? err.message : String(err)}` });
    toast('error', 'Device state failed', err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    await api.telemetryStart(deviceId);
    api.onTelemetrySample((sample) => store.set({ latestSample: sample }));
  } catch (err) {
    toast('warn', 'Telemetry unavailable', err instanceof Error ? err.message : String(err));
  }

  console.log(`[renderer] boot complete — device ${deviceId}${health?.backend === 'mock' ? ' (mock)' : ''}`);
}

void boot();
