// Arc Power — renderer bootstrap: boot sequence (health -> devices -> caps
// -> state -> telemetry), shell render (sidebar + GPU header + page), and
// hash routing.

import { api } from './ipc.ts';
import { el, clear } from './dom.ts';
import { Store, currentPage, NAV_LABELS, PAGE_IDS } from './router.ts';
import type { Page, PageId } from './router.ts';
import { GpuHeader } from './components/header.ts';
import { toast } from './components/toast.ts';
import { dashboardPage } from './pages/dashboard.ts';
import { overclockingPage } from './pages/overclocking.ts';
import { fanPage } from './pages/fan.ts';
import { monitoringPage } from './pages/monitoring.ts';
import { profilesPage } from './pages/profiles.ts';
import { tweaksPage } from './pages/placeholder.ts';

const PAGES: Record<PageId, Page> = {
  dashboard: dashboardPage,
  overclocking: overclockingPage,
  fan: fanPage,
  monitoring: monitoringPage,
  profiles: profilesPage,
  tweaks: tweaksPage,
};

const store = new Store();
const header = new GpuHeader(document.getElementById('gpu-header') as HTMLElement, store);
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

  // Display-driver registry date (M2b-B, read-only): a lookup failure
  // degrades to null and the header shows the driver version alone.
  try {
    const info = await api.driverInfo();
    store.set({ driverDate: info?.driverDate ?? null });
  } catch {
    store.set({ driverDate: null });
  }

  // IGS state probe at boot (read-only). Failure degrades to
  // not-detected — the app must not go red because the probe failed.
  try {
    const igsState = await api.getIgsServiceState();
    store.set({ igsState });
  } catch {
    store.set({ igsState: { service: { found: false, running: false, startType: 'unknown' }, appRunning: false } });
  }

  try {
    const caps = await api.getCapabilities(deviceId);
    const state = await api.getCurrentSettings(deviceId);
    store.set({ caps, state });
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
