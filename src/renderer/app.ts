// Arc Power - renderer bootstrap: boot sequence (health -> devices -> caps
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
import { monitoringPage, redrawMonitoringGraphs } from './pages/monitoring.ts';
import { profilesPage } from './pages/profiles.ts';
import { tweaksPage } from './pages/tweaks.ts';
import { settingsPage } from './pages/settings.ts';
import { overlaySettingsPage } from './pages/overlay-settings.ts';
import { setMonitorLogToFile, getMonitorLogToFile, getLatestFps } from './log-state.ts';
import { createDeviceSwitcher } from './device.ts';
import { resolveBootDevice } from './pure/device.ts';
import { isValidTheme } from './pure/theme.ts';
import { primaryVideoController } from './pure/sysinfo.ts';

const PAGES: Record<PageId, Page> = {
  dashboard: dashboardPage,
  tuning: tuningPage,
  monitoring: monitoringPage,
  profiles: profilesPage,
  tweaks: tweaksPage,
  settings: settingsPage,
  // M6: the #/overlay page (the Overlay Settings page - the Settings
  // card's "Overlay settings" button destination).
  overlay: overlaySettingsPage,
};

const store = new Store();

// 1.0.1 Themes: apply a theme id to <html> + recolor the monitoring
// canvases NOW (N9 - drawSeries reads the CSS vars at draw time; a theme
// switch must not wait for the next telemetry tick). The dataset write
// lives HERE (and in settings.ts), never in pure/theme.ts (N8 - that module
// stays DOM-free). An invalid id degrades to 'dark' (the same fallback the
// store applies).
export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = isValidTheme(theme) ? theme : 'dark';
  redrawMonitoringGraphs();
}
const header = new GpuHeader(document.getElementById('gpu-header') as HTMLElement, store, {
  // M2D: the mock featureset swap re-reads caps + state + device + health in
  // main (one mock:set-featureset round trip) and re-renders the whole page
  // so ranges/units/controls/monitoring all update live. Mock mode only.
  // M4-F (F1): the swap response carries a SINGLE caps/state pair (device 0
  // of the rebuilt list) - with a non-zero device selected (the 2-device
  // mock session) the CURRENT device's pair is re-read so the current
  // deviceId is NEVER paired with device-0's ranges (device 1 stays the
  // arc-igpu line across a swap - pairing it with b580's percent ranges
  // would render the wrong surface).
  onFeaturesetSwap: async (id: string) => {
    // 1.0.1 no-Intel round (m5): the swap is a NO-OP in the no-device mode -
    // a swap would store caps/state into the no-Intel store and break the
    // presentation (the dropdown itself is hidden there too).
    if (store.get().noIntel) return;
    try {
      const out = await api.mockSetFeatureset(id);
      const curId = store.get().deviceId;
      const caps = curId !== null && curId !== 0 ? await api.getCapabilities(curId) : out.caps;
      const state = curId !== null && curId !== 0 ? await api.getCurrentSettings(curId) : out.state;
      store.set({
        devices: out.devices,
        caps,
        state,
        health: out.health,
        featuresetId: out.featureset.id,
        // M2D: the swap replaces the boot registry date with the featureset's
        // own (null when unverified) - the device card must never pair the
        // new driver version with the boot featureset's stale date.
        driverDate: out.driverDate ?? null,
      });
      renderPage(currentPage());
    } catch (err) {
      toast('error', 'Featureset swap failed', err instanceof Error ? err.message : String(err));
    }
  },
});

// M4-F: the GPU switch - one instance wired to the app's store, page
// re-render and toast sink; exported so the Dashboard GPU card + Tuning
// page selectors drive it. The full flow + the unit-tested core live in
// device.ts (createDeviceSwitcher).
export const selectDevice = createDeviceSwitcher({
  api,
  store,
  onSwitched: () => {
    renderPage(currentPage());
  },
  warn: (title, message) => toast('warn', title, message),
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
    // M4-D (user): the sidebar brand - "Arc Power" with "Power" ILLUMINATED
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
    // M4-H (D1): the sidebar FOOTER - the GitHub link (icon + 'GitHub') at
    // the bottom-left; click -> api.openExternal (a NEW validated IPC
    // channel - ipc-core.js strict-checks https://github.com/YamsSE/Arc-Power
    // before shell.openExternal runs). The <a> has no href - the click is
    // the only path (a real navigation would reload the app shell).
    el('div', { class: 'sidebar-footer' }, [
      el('a', {
        class: 'sidebar-footer-link',
        title: 'Open the Arc Power repository',
        onClick: (e: Event) => {
          e.preventDefault();
          void api.openExternal('https://github.com/YamsSE/Arc-Power').catch(() => {
            toast('error', 'Could not open GitHub', 'The repository link could not be opened.');
          });
        },
      }, [
        el('span', { class: 'sidebar-icon-github' }),
        el('span', { class: 'sidebar-footer-label', text: 'GitHub' }),
      ]),
    ]),
  );
}

async function boot() {
  // M4-D (user): the integrated title bar (frameless window) - the window
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

  // 1.0.1 Themes (M3): the persisted UI theme + the M4-D2 log-to-file
  // toggle ride the SAME profiles envelope read, hoisted right after health
  // so the theme applies EARLY (the first paint is already on the persisted
  // theme - no visible flash) and the boot-level telemetry subscription
  // below sees the log toggle in time. A read failure degrades to the dark
  // default + logging off (never blocks boot).
  let persistedTheme = 'dark';
  try {
    const env = await api.profilesList();
    persistedTheme = isValidTheme(env.settings.theme) ? env.settings.theme : 'dark';
    setMonitorLogToFile(env.settings.monitorLogToFile === true);
  } catch {
    setMonitorLogToFile(false);
  }
  applyTheme(persistedTheme);

  // M2D: in mock mode fill the featureset dropdown (the mock-only IPC; real
  // mode has no channel - the catch keeps the dropdown hidden).
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

  // 1.0.1 no-Intel round (S1): the boot branches on devices.length === 0
  // (NEVER on a derived flag). On the no-Intel path the WHOLE deviceId
  // resolution block below is SKIPPED (deviceId stays null - resolveBootDevice
  // returns null on [] and devices[0].id would throw a TypeError; the block
  // stays exactly as-is for the non-empty path). caps/state stay null there;
  // the boot-level telemetry subscription + telemetryStart(null) (the
  // no-device mode) run on BOTH paths; the noIntel store flag is set after.
  const noIntel = devices.length === 0;
  // M4-F: the boot device id - resolved ONLY on the Intel path (S1: the
  // no-Intel path skips the whole resolution block and deviceId stays
  // null). Read by the caps/state block and the final telemetryStart below.
  let deviceId: number | null = null;
  if (!noIntel) {
    // M4-F: boot selection - the persisted deviceId wins when it matches an
    // enumerated id (device-get; the MAIN-side boot resolution is the
    // authority and has already self-healed the persisted id before this
    // round trip), else devices[0]. The main-side resolution applies the
    // same rule to the boot-apply target, so the renderer and the boot
    // apply can never disagree.
    let persistedDeviceId: number | null = null;
    try {
      persistedDeviceId = (await api.deviceGet()).deviceId;
    } catch {
      persistedDeviceId = null; // degraded: devices[0]
    }
    // (devices.length > 0 is guaranteed here - the empty enumeration branched
    // above - so the resolution is always a concrete id).
    deviceId = resolveBootDevice(devices, persistedDeviceId) ?? devices[0].id;
    store.set({ deviceId });
  }

  // App version for the header line (M2C-B B3). Failure degrades to the
  // initial placeholder - the header stays up.
  try {
    const v = await api.appVersion();
    store.set({ appVersion: v?.version ?? '0.0.0' });
  } catch {
    store.set({ appVersion: '0.0.0' });
  }

  // M4-E: the distribution kind (app:build-info IPC) - the Settings
  // start-with-Windows hint differentiates by it. Failure degrades to 'dev'.
  try {
    const b = await api.appBuildInfo();
    store.set({ buildKind: b?.kind ?? 'dev' });
  } catch {
    store.set({ buildKind: 'dev' });
  }

  // M4N (A.1): the window-path boot apply's outcome - a successful boot
  // apply must flip the dashboard OC Status row GREEN (the apply runs in
  // main before the window exists; this fetch is how the renderer learns
  // it). Null -> nothing applied at boot (the row stays "No OC apply yet
  // in this session"). The lastApply slot is part of the dashboard render
  // signature, so the fetch re-renders the row even when nothing else
  // changed since the first render.
  try {
    const o = await api.bootApplyOutcome();
    if (o) store.set({ lastApply: { ok: o.ok === true, at: o.at, detail: o.detail } });
  } catch {
    // degraded: the row stays on its pre-fetch state (the OC row is honest)
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
  // the card renders '-' rows; when the payload lands AFTER the first render
  // the dashboard sig (sysinfo slot) triggers the re-render.
  try {
    const info = await api.sysinfo();
    store.set({ sysinfo: info ?? null });
  } catch {
    store.set({ sysinfo: null });
  }
  // 1.0.1 no-Intel round: the OS GPU - the sysinfo PRIMARY non-basic video
  // controller (mirror matchVideoController's pick for a model-less device
  // name; pure helper). Set on the no-Intel path only (the Intel path
  // renders the IGCL device list instead). Lands in the SAME store.set as
  // the noIntel flag below so the dashboard GPU card re-renders once.
  const osGpu = noIntel ? primaryVideoController(store.get().sysinfo) : null;

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

  // M2C-C elevation state (cached koffi probe - never spawns). Failure
  // degrades to not-elevated + no worker (the UI then behaves as a plain
  // elevated-in-process app - the apply either works or fails honestly).
  try {
    const e = await api.appElevated();
    store.set({ elevated: e?.elevated === true, workerApply: e?.workerApply === true });
  } catch {
    store.set({ elevated: false, workerApply: false });
  }

  // M3-C-E: the persisted OC mode (stock|advanced). Failure degrades to the
  // safe default ('stock' - main keeps its own default; the toggle re-syncs).
  try {
    const m = await api.ocModeGet();
    store.set({ ocMode: m?.ocMode === 'advanced' ? 'advanced' : 'stock' });
  } catch {
    store.set({ ocMode: 'stock' });
  }

  if (noIntel) {
    // 1.0.1 no-Intel round: caps/state are SKIPPED on the no-device path
    // (they stay null - there is no IGCL device to read, and the waiver
    // prompt + the OC surface must never render).
  } else {
    try {
      const caps = await api.getCapabilities(deviceId as number);
      const state = await api.getCurrentSettings(deviceId as number);
      store.set({ caps, state });
      // M4-B: the OC waiver prompt shows at EVERY startup while the waiver is
      // NOT accepted (the user: "please prompt it when the Program opens").
      // M4-D (user, PERMANENT acceptance): a PERSISTED acceptance is the
      // user's permanent consent - the boot prompt is SKIPPED entirely then
      // (the accepted-state reminder dialog is REMOVED; the dashboard health
      // row remains the status display). The driver-side waiver state cannot
      // be probed from the renderer (IGCL exposes only ctlOverclockWaiverSet
      // - no getter), so the dialog at open is the only reliable visibility
      // for never-accepted sessions. NON-BLOCKING: the boot sequence
      // continues; a declined prompt must not break it. Accept patches the
      // store caps so the dashboard GPU Health card row flips to Accepted in
      // place.
      if (caps.waiverAccepted !== true) {
        void (async () => {
          const decision = await promptWaiverAtBoot(deviceId as number, caps.deviceName || 'this GPU');
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
  }

  // M4-D2 (§10): the Monitoring "Log to file" + the 1.0.1 theme are read
  // ONCE at boot from the hoisted profiles envelope (right after health -
  // M3); the Settings/Monitoring pages update the shared state after their
  // saves.

  // M4-F (M5): the boot-level telemetry subscription is registered OUTSIDE
  // the telemetryStart try - a later switch's telemetryStart must ALWAYS
  // push (the handler is session-global, never tied to one device's start
  // success).
  // M4-D2 (§10): the log send lives in this BOOT-LEVEL subscription -
  // logging continues across page navigation. On EVERY pushed sample, when
  // the Log-to-file toggle is on, append the sample + the best-effort fps
  // (the module-level latest FPS the Monitoring page's poll updates; the
  // sample's own fields make up the rest). Same tick cadence as the
  // telemetry push - NO extra timers. The append result carries the log
  // file path - the append result is best-effort only (nothing displays the
  // path; the Settings card shows the persisted toggle state).
  // 1.0.1 no-Intel round (S1): registered on BOTH boot paths - the
  // no-device telemetry push (telemetry-start null mode) rides the SAME
  // subscription, so log-file logging works for free there.
  api.onTelemetrySample((sample) => {
    store.set({ latestSample: sample });
    if (getMonitorLogToFile()) {
      void api.monitorLogAppend({ ...sample, fps: getLatestFps() })
        .catch(() => { /* a failed append never breaks the UI */ });
    }
  });

  if (noIntel) {
    // 1.0.1 no-Intel round: the no-device telemetry mode -
    // telemetryStart(null) pushes sys-stats-ONLY samples (t: Date.now() +
    // cpuUtilPct/cpuTempC/cpuFreqMhz/gpuMemUsedBytes - all OS-level, they
    // work on any GPU); the monitoring CPU/GPU-mem tiles go live, the GPU
    // device tiles honestly stay '-'.
    try {
      await api.telemetryStart(null);
    } catch (err) {
      toast('warn', 'Telemetry unavailable', err instanceof Error ? err.message : String(err));
    }
    // S1: the noIntel store flag lands AFTER the null-mode start (and in
    // the same set as osGpu so the dashboard GPU card re-renders once).
    store.set({ noIntel: true, osGpu });
    console.log('[renderer] boot complete - no Intel GPU');
  } else {
    try {
      await api.telemetryStart(deviceId as number);
    } catch (err) {
      toast('warn', 'Telemetry unavailable', err instanceof Error ? err.message : String(err));
    }

    console.log(`[renderer] boot complete - device ${deviceId}${health?.backend === 'mock' ? ' (mock)' : ''}`);
  }
}

void boot();
