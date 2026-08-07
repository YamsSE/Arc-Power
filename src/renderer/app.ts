// Arc Power — renderer bootstrap: boot sequence (health -> devices -> caps
// -> state -> telemetry), shell render (sidebar + GPU header + page), and
// hash routing.

import { api } from './ipc.ts';
import { el, clear } from './dom.ts';
import { Store, currentPage, NAV_LABELS, PAGE_IDS } from './router.ts';
import type { Page, PageId } from './router.ts';
import { GpuHeader } from './components/header.ts';
import { toast } from './components/toast.ts';
import { initTitlebar } from './components/titlebar.ts';
import { promptWaiverAtBoot } from './components/waiver-dialog.ts';
import { dashboardPage } from './pages/dashboard.ts';
import { tuningPage } from './pages/tuning.ts';
import { monitoringPage } from './pages/monitoring.ts';
import { profilesPage } from './pages/profiles.ts';
import { tweaksPage } from './pages/tweaks.ts';
import { settingsPage } from './pages/settings.ts';
import { setMonitorLogToFile, setCurrentLogFile, getMonitorLogToFile, getLatestFps } from './log-state.ts';

const PAGES: Record<PageId, Page> = {
  dashboard: dashboardPage,
  tuning: tuningPage,
  monitoring: monitoringPage,
  profiles: profilesPage,
  tweaks: tweaksPage,
  settings: settingsPage,
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
    // M4-D (user): the sidebar brand — "Arc Power" with "Power" ILLUMINATED
    // like the title bar (the blue gradient + glow) and a BOLD weight; the
    // small blue accent bar below stays.
    el('div', { class: 'sidebar-brand' }, [
      el('span', { class: 'sidebar-brand-arc', text: 'Arc ' }),
      el('span', { class: 'sidebar-brand-power', text: 'Power' }),
    ]),
    el('nav', { class: 'sidebar-nav' }, PAGE_IDS.map((id) =>
      el('a', {
        class: `sidebar-link${id === active ? ' active' : ''}`,
        href: `#/${id}`,
      }, [
        // M4-D (user): one fitting icon per tab, left of the name.
        el('span', { class: `sidebar-icon sidebar-icon-${id}` }),
        el('span', { class: 'sidebar-link-label', text: NAV_LABELS[id] }),
      ]),
    )),
  );
}

async function boot() {
  // M4-D (user): the integrated title bar (frameless window) — the window
  // buttons + the maximized-state icon subscription. Static markup, wired
  // before the boot sequence so the buttons work immediately.
  initTitlebar();

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

  // M4-D (user): the system info (dashboard CPU & memory card + the real-GPU
  // VRAM source). Fire-and-forget semantics: a failure degrades to null and
  // the card renders '—' rows; when the payload lands AFTER the first render
  // the dashboard sig (sysinfo slot) triggers the re-render.
  try {
    const info = await api.sysinfo();
    store.set({ sysinfo: info ?? null });
  } catch {
    store.set({ sysinfo: null });
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
    // M4-B: the OC waiver prompt shows at EVERY startup while the waiver is
    // NOT accepted (the user: "please prompt it when the Program opens").
    // M4-D (user, PERMANENT acceptance): a PERSISTED acceptance is the
    // user's permanent consent — the boot prompt is SKIPPED entirely then
    // (the accepted-state reminder dialog is REMOVED; the dashboard health
    // row remains the status display). The driver-side waiver state cannot
    // be probed from the renderer (IGCL exposes only ctlOverclockWaiverSet
    // — no getter), so the dialog at open is the only reliable visibility
    // for never-accepted sessions. NON-BLOCKING: the boot sequence
    // continues; a declined prompt must not break it. Accept patches the
    // store caps so the dashboard GPU Health card row flips to Accepted in
    // place.
    if (caps.waiverAccepted !== true) {
      void (async () => {
        const decision = await promptWaiverAtBoot(deviceId, caps.deviceName || 'this GPU');
        if (decision !== 'accepted') return;
        const live = store.get();
        if (live.caps && live.caps.waiverAccepted !== true) {
          store.set({ caps: { ...live.caps, waiverAccepted: true } });
        }
      })();
    }
  } catch (err) {
    store.set({ bootError: `Could not read device state: ${err instanceof Error ? err.message : String(err)}` });
    toast('error', 'Device state failed', err instanceof Error ? err.message : String(err));
    return;
  }

  // M4-D2 (§10): the Monitoring "Log to file" persisted toggle — the BOOT
  // sequence reads it ONCE (the Settings/Monitoring pages update the shared
  // state after their saves); a read failure degrades to off (never blocks
  // boot).
  try {
    const env = await api.profilesList();
    setMonitorLogToFile(env.settings.monitorLogToFile === true);
  } catch {
    setMonitorLogToFile(false);
  }

  try {
    await api.telemetryStart(deviceId);
    // M4-D2 (§10): the log send lives in the BOOT-LEVEL telemetry
    // subscription (plan-review M5) — logging continues across page
    // navigation. On EVERY pushed sample, when the Log-to-file toggle is
    // on, append the sample + the best-effort fps (the module-level latest
    // FPS the Monitoring page's poll updates; the sample's own fields make
    // up the rest). Same tick cadence as the telemetry push — NO extra
    // timers. The append result carries the CSV path — surfaced to the
    // Monitoring page's "current log path" line.
    api.onTelemetrySample((sample) => {
      store.set({ latestSample: sample });
      if (getMonitorLogToFile()) {
        void api.monitorLogAppend({ ...sample, fps: getLatestFps() })
          .then((res) => {
            if (res && typeof (res as { file?: unknown }).file === 'string') {
              setCurrentLogFile((res as { file: string }).file);
            }
          })
          .catch(() => { /* a failed append never breaks the UI */ });
      }
    });
  } catch (err) {
    toast('warn', 'Telemetry unavailable', err instanceof Error ? err.message : String(err));
  }

  console.log(`[renderer] boot complete — device ${deviceId}${health?.backend === 'mock' ? ' (mock)' : ''}`);
}

void boot();
