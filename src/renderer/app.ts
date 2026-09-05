// Arc Power - renderer bootstrap: boot sequence (health -> devices -> caps
// -> state -> telemetry), shell render (sidebar + GPU header + page), and
// hash routing.

import { api } from './ipc.ts';
import { stopTelemetry, startTelemetry } from './device.ts';
import { el, clear } from './dom.ts';
import { Store, currentPage, NAV_LABELS, PAGE_IDS } from './router.ts';
import type { Page, PageId } from './router.ts';
import { GpuHeader } from './components/header.ts';
import { toast } from './components/toast.ts';
import { initTitlebar, setTitlebarVersion, startupUpdateCheck } from './components/titlebar.ts';
import { promptWaiverAtBoot } from './components/waiver-dialog.ts';
import { dashboardPage } from './pages/dashboard.ts';
import { tuningPage } from './pages/tuning.ts';
import { graphicsPage } from './pages/graphics.ts';
import { monitoringPage, redrawMonitoringGraphs } from './pages/monitoring.ts';
import { recordingPage } from './pages/recording.ts';
import { profilesPage } from './pages/profiles.ts';
import { tweaksPage } from './pages/tweaks.ts';
import { settingsPage } from './pages/settings.ts';
import { getLatestFpsSample, getMonitorLogToFile, filterMonitorLogSample, setMonitorLogMetrics, setMonitorLogToFile } from './log-state.ts';
import { createDeviceSwitcher } from './device.ts';
import { deviceHardwareKey, resolveBootDevice, resolveFeaturesetSwapSelection } from './pure/device.ts';
import { isValidTheme } from './pure/theme.ts';
import { primaryVideoController } from './pure/sysinfo.ts';
import type { RecordingEngineState, TelemetrySample } from './types.ts';
import { closeDropdownMenus } from './components/dropdown.ts';

const PAGES: Record<PageId, Page> = {
  dashboard: dashboardPage,
  tuning: tuningPage,
  // M8: the #/graphics page (the Graphics tab - below Tuning in the
  // sidebar). An unregistered id falls back to the dashboard (S3).
  graphics: graphicsPage,
  monitoring: monitoringPage,
  recording: recordingPage,
  profiles: profilesPage,
  tweaks: tweaksPage,
  settings: settingsPage,
};

const store = new Store();

const INITIAL_RECORDING_STATUS: RecordingEngineState = {
  available: false,
  running: false,
  mode: null,
  startedAt: null,
  error: 'Loading capture engine…',
  encoders: [],
  audioInputs: [],
  audioOutputs: [],
  hotkeys: { registered: {}, conflicts: {}, error: null },
};
let globalRecordingStatus: RecordingEngineState = INITIAL_RECORDING_STATUS;
let globalRecordingTimer: number | null = null;
let unsubscribeGlobalRecordingState: (() => void) | null = null;

function recordingElapsed(startedAt: number | null | undefined): string {
  if (!Number.isFinite(startedAt)) return '00:00:00';
  const elapsed = Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function updateGlobalRecordingWidget(target?: HTMLElement): void {
  const root = target ?? document.querySelector<HTMLElement>('.sidebar-recording-status');
  if (!root) return;
  const running = globalRecordingStatus.running === true;
  const state = running ? 'live' : globalRecordingStatus.available ? 'ready' : 'offline';
  const mode = globalRecordingStatus.mode;
  const title = root.querySelector<HTMLElement>('[data-recording-status-title]');
  const detail = root.querySelector<HTMLElement>('[data-recording-status-detail]');
  const timer = root.querySelector<HTMLElement>('[data-recording-timer]');
  const dot = root.querySelector<HTMLElement>('[data-recording-status-dot]');
  if (title) title.textContent = running ? mode === 'replay' ? 'Replay buffer' : 'Recording' : globalRecordingStatus.available ? 'Ready to capture' : 'Capture offline';
  if (detail) detail.textContent = running ? 'Arc Capture is running' : globalRecordingStatus.available ? 'Ready when you are' : 'Capture engine unavailable';
  if (timer) {
    timer.textContent = running ? recordingElapsed(globalRecordingStatus.startedAt) : '';
    timer.hidden = !running;
  }
  if (dot) dot.className = `sidebar-recording-dot is-${state}`;
  root.classList.toggle('is-live', state === 'live');
  root.classList.toggle('is-ready', state === 'ready');
  root.classList.toggle('is-offline', state === 'offline');
  root.dataset.state = state;
  root.dataset.mode = mode ?? 'idle';
}

function setGlobalRecordingStatus(next: RecordingEngineState): void {
  const startedAt = next.running
    ? Number.isFinite(next.startedAt) ? next.startedAt : globalRecordingStatus.startedAt ?? Date.now()
    : null;
  globalRecordingStatus = { ...next, startedAt };
  store.set({ recordingStatus: globalRecordingStatus });
  if (globalRecordingStatus.running && globalRecordingTimer === null) {
    globalRecordingTimer = window.setInterval(updateGlobalRecordingWidget, 1000);
  } else if (!globalRecordingStatus.running && globalRecordingTimer !== null) {
    window.clearInterval(globalRecordingTimer);
    globalRecordingTimer = null;
  }
  updateGlobalRecordingWidget();
}

function renderGlobalRecordingStatus(): HTMLElement {
  const root = el('section', { class: 'sidebar-recording-status', 'aria-live': 'polite', 'aria-label': 'Arc Capture status' }, [
    el('span', { class: 'sidebar-recording-dot', 'data-recording-status-dot': '' }),
    el('div', { class: 'sidebar-recording-copy' }, [
      el('strong', { 'data-recording-status-title': '' }),
      el('span', { 'data-recording-status-detail': '' }),
    ]),
    el('time', { class: 'sidebar-recording-timer', 'data-recording-timer': '', hidden: true }),
  ]);
  updateGlobalRecordingWidget(root);
  return root;
}

// 1.0.1 Themes: apply a theme id to <html> + recolor the monitoring
// canvases NOW (N9 - drawMiniSeries reads the CSS vars at draw time; a theme
// switch must not wait for the next telemetry tick). The dataset write
// lives HERE (and in settings.ts), never in pure/theme.ts (N8 - that module
// stays DOM-free). An invalid id degrades to 'dark' (the same fallback the
// store applies). The query is kept in sync without a reload so a later
// navigation/reload bootstraps the current persisted theme.
export function applyTheme(theme: string): void {
  const normalized = isValidTheme(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = normalized;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('theme', normalized);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A non-browser unit harness may not expose a mutable location/history.
  }
  redrawMonitoringGraphs();
}
let featuresetSwapInFlight = false;

/**
 * Keep one live telemetry lane for every physical adapter. The selected
 * adapter owns the normal telemetry session; the remaining adapters use the
 * identity-bound secondary lanes that already power the overlay. Reissuing
 * the complete list on selection changes also moves the previous focus into
 * the secondary set without leaving a stale lane behind.
 */
async function configureDashboardTelemetry(focusedId: number | null, devices: Array<{ id: number }>): Promise<void> {
  const secondaryIds = devices
    .map((device) => device.id)
    .filter((id) => Number.isInteger(id) && id >= 0 && id !== focusedId);
  try {
    await api.overlayTelemetryStart(secondaryIds);
  } catch (err) {
    toast('warn', 'Telemetry', `Additional GPU telemetry could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    const before = store.get();
    if (before.noIntel || featuresetSwapInFlight) return;
    featuresetSwapInFlight = true;
    const warn = (title: string, message: string) => toast('warn', title, message);
    let swapApplied = false;
    let targetId: number | null = null;
    let targetTelemetryStarted = false;
    try {
      // Stop the old numeric session before main rebuilds the list. The
      // returned devices get fresh ids, so leaving this service alive would
      // keep polling the old id after a stable-key reorder.
      await stopTelemetry(api, before.deviceId, warn);
      let out;
      try {
        out = await api.mockSetFeatureset(id);
      } catch (err) {
        // A failed swap leaves the existing renderer selection in place;
        // restore its session rather than leaving telemetry stopped.
        await startTelemetry(api, before.deviceId, warn);
        throw err;
      }
      swapApplied = true;
      // The returned list has freshly assigned session ids. Read-only or
      // unsupported selections keep their durable identity so the no-tuning
      // surface survives; writable selections follow the requested physical
      // slot instead of sticking to a same-key secondary row.
      const selected = before.devices.find((device) => device.id === before.deviceId);
      const selectedKey = selected?.deviceKey ?? null;
      const preserveSelected = selected?.synthetic === true
        || selected?.backendKind === 'os'
        || before.caps?.overclockingSupported === false
        || (before.caps !== null && !Object.values(before.caps.controls).some(Boolean));
      const selection = resolveFeaturesetSwapSelection(
        out.devices,
        selectedKey,
        out.activeDeviceKey ?? null,
        preserveSelected,
      );
      const target = selection.device;
      if (!target) throw new Error('the featureset returned no devices');
      targetId = target.id;
      const caps = await api.getCapabilities(target.id);
      const state = await api.getCurrentSettings(target.id);
      // Start exactly one service for the freshly resolved session id.
      targetTelemetryStarted = await startTelemetry(api, target.id, warn);
      await configureDashboardTelemetry(target.id, out.devices);
      // If the old stable key disappeared, persist the visible fallback so
      // the next boot does not resurrect the stale selection.
      if (!selection.preserved) {
        try {
          await api.deviceSet({ deviceId: target.id, deviceKey: target.deviceKey });
        } catch (err) {
          warn('GPU selection', `The fallback selection could not be saved for this session (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      store.set({
        devices: out.devices,
        deviceId: target.id,
        caps,
        state,
        latestSample: null,
        latestSamples: {},
        health: out.health,
        featuresetId: out.featureset.id,
        // M2D: the swap replaces the boot registry date with the featureset's
        // own (null when unverified) - the device card must never pair the
        // new driver version with the boot featureset's stale date.
        driverDate: out.driverDate ?? null,
      });
      try {
        const ready = await mainSelectionGenerationReady;
        if (ready) {
          mainSelectionGeneration += 1;
          await api.deviceSelectionPush({
            deviceId: target.id,
            deviceKey: target.deviceKey ?? null,
            selectionGeneration: mainSelectionGeneration,
            caps,
            state,
          });
        }
      } catch (err) {
        toast('warn', 'GPU selection', `The other window could not be updated: ${err instanceof Error ? err.message : String(err)}`);
      }
      renderPage(currentPage());
    } catch (err) {
      if (swapApplied) {
        // A post-swap read/start/render failure must not strand the old
        // session without telemetry. Stop a successfully started target
        // before restoring the previous session, best effort.
        if (targetTelemetryStarted && targetId !== null) {
          await stopTelemetry(api, targetId, warn);
        }
        await startTelemetry(api, before.deviceId, warn);
      }
      toast('error', 'Featureset swap failed', err instanceof Error ? err.message : String(err));
    } finally {
      featuresetSwapInFlight = false;
    }
  },
});

// The main renderer owns this sequence. It lets ipc-core distinguish a late
// push from an older switch even when deviceSet persistence failed. The
// handshake seeds the counter after a renderer reload, while ipc-core keeps
// the latest value in the main process.
let mainSelectionGeneration = -1;
const mainSelectionGenerationReady = api.deviceSelectionGenerationGet()
  .then(({ generation }) => {
    if (!Number.isInteger(generation) || generation < -1) throw new Error('invalid selection generation');
    mainSelectionGeneration = generation;
    return true;
  })
  .catch((err) => {
    toast('warn', 'GPU selection', `Could not synchronize selection generation: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  });
export const selectDevice = createDeviceSwitcher({
  api,
  store,
  onSwitched: (id) => {
    renderPage(currentPage());
    void configureDashboardTelemetry(id, store.get().devices);
    void mainSelectionGenerationReady.then((ready) => {
      if (!ready) return;
      const live = store.get();
      // A newer local switch may have completed while the reload handshake
      // was pending; never publish the superseded device pair.
      if (live.deviceId !== id || !live.caps || !live.state) return;
      const selected = live.devices.find((device) => device.id === id);
      const selectionGeneration = ++mainSelectionGeneration;
      return api.deviceSelectionPush({
        deviceId: id,
        deviceKey: selected?.deviceKey ?? null,
        selectionGeneration,
        caps: live.caps,
        state: live.state,
      }).catch((err) => toast('warn', 'GPU selection', `The other window could not be updated: ${err instanceof Error ? err.message : String(err)}`));
    });
  },
  warn: (title, message) => toast('warn', title, message),
  queueWhileInFlight: true,
});

// M31: only the main renderer consumes panel requests. Durable-key
// resolution happens against the current inventory; the existing switcher
// remains the sole telemetry stop/start + persistence owner. Requests that
// arrive during boot are coalesced and replayed after the boot owner settles.
let mainBootComplete = false;
let queuedDeviceSelectionKey: string | null = null;
function requestDeviceSelection(deviceKey: string): void {
  if (!mainBootComplete) {
    queuedDeviceSelectionKey = deviceKey;
    return;
  }
  const target = store.get().devices.find((device) => device.deviceKey === deviceKey);
  if (!target) {
    toast('warn', 'GPU selection', 'The requested GPU is no longer available.');
    return;
  }
  void selectDevice(target.id);
}
api.onDeviceSelectionRequested((payload) => {
  if (!payload || typeof payload.deviceKey !== 'string') return;
  requestDeviceSelection(payload.deviceKey);
});
api.onDeviceSelectionUpdated((payload) => {
  if (!payload?.caps || !payload?.state || !Number.isInteger(payload.deviceId)) return;
  const live = store.get();
  const target = live.devices.find((device) => device.id === payload.deviceId
    && (payload.deviceKey === null || device.deviceKey === payload.deviceKey));
  if (!target) return;
  if (live.deviceId === payload.deviceId
    && live.caps === payload.caps
    && live.state === payload.state) return;
  store.set({
    deviceId: payload.deviceId,
    caps: payload.caps,
    state: payload.state,
    latestSample: live.latestSamples[target.deviceKey ?? deviceHardwareKey(target)] ?? null,
    lastApply: null,
    osGpu: target.osController ?? null,
  });
  renderPage(currentPage());
});
let current: Page | null = null;

function renderPage(id: PageId) {
  const container = document.getElementById('page') as HTMLElement;
  // M2b review F4: the page being left stops its timers/subscriptions
  // (e.g. Monitoring's FPS poll) before the next page renders.
  current?.leave?.();
  // Shared dropdown menus are portaled to document.body. Close the active
  // portal before replacing the page or device surface so stale options and
  // focus state cannot survive a navigation/rerender.
  closeDropdownMenus();
  current = PAGES[id] ?? dashboardPage;
  try {
    current.render(container, { store, selectDevice });
  } catch (err) {
    clear(container);
    container.append(el('p', { class: 'text-error', text: `Page failed to render: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

function renderSidebar() {
  const nav = document.getElementById('sidebar') as HTMLElement;
  const active = currentPage();
  clear(nav);
  // Settings remains in the sidebar footer. PAGE_IDS supplies the exact
  // main-tab order: Dashboard, Tuning, Graphics, Recording, Monitoring,
  // Profiles, Tweaks.
  const navIds = PAGE_IDS.filter((id) => id !== 'settings');
  nav.append(
    // M4-D: the sidebar brand - "Arc Power" with "Power" ILLUMINATED
    // like the title bar (the blue gradient + glow) and a BOLD weight; the
    // small blue accent bar below stays.
    el('div', { class: 'sidebar-brand' }, [
      el('span', { class: 'sidebar-brand-arc', text: 'Arc ' }),
      el('span', { class: 'sidebar-brand-power', text: 'Power' }),
    ]),
    el('nav', { class: 'sidebar-nav' }, navIds.map((id) =>
      el('a', {
        class: `sidebar-link${id === active ? ' active' : ''}`,
        href: `#/${id}`,
      }, [
        // M4-D: one fitting icon per tab, left of the name.
        el('span', { class: `sidebar-icon sidebar-icon-${id}` }),
        el('span', { class: 'sidebar-link-label', text: NAV_LABELS[id] }),
      ]),
    )),
    el('div', { class: 'sidebar-footer' }, [
      renderGlobalRecordingStatus(),
      el('div', { class: 'sidebar-footer-links' }, [
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
        el('a', {
          class: `sidebar-link sidebar-footer-settings${active === 'settings' ? ' active' : ''}`,
          href: '#/settings',
          title: 'Settings',
        }, [
          el('span', { class: 'sidebar-icon sidebar-icon-settings' }),
          el('span', { class: 'sidebar-link-label', text: NAV_LABELS.settings }),
        ]),
      ]),
    ]),
  );
  updateGlobalRecordingWidget();
}

async function boot() {
  // M17d (Run E): the --profile-boot harness marks. The main process passes
  // the flag via the window load query (the sandboxed renderer has no env
  // access); without it these lines never print (product runs stay silent).
  // first-paint = the double-rAF right after the first paint completes.
  const profileBoot = new URLSearchParams(window.location.search).get('profileBoot') === '1';
  const pb = (name: string) => {
    if (profileBoot) console.log(`[profile-boot] renderer:${name}`);
  };
  if (profileBoot) requestAnimationFrame(() => requestAnimationFrame(() => pb('first-paint')));

  // M4-D: the integrated title bar (frameless window) - the window
  // buttons + the maximized-state icon subscription. Static markup, wired
  // before the boot sequence so the buttons work immediately.
  initTitlebar();
  // M25/M52: check independently of the GPU bootstrap. A device/driver
  // probe must never prevent the user from seeing a release notification.
  void startupUpdateCheck();

  // Capture status is app-global: the sidebar widget remains visible while
  // the user moves between pages, and its timer stops as soon as capture ends.
  if (!unsubscribeGlobalRecordingState) {
    unsubscribeGlobalRecordingState = api.onRecordingStateUpdated((next) => setGlobalRecordingStatus(next));
  }
  void api.recordingStatus().then((next) => setGlobalRecordingStatus(next)).catch(() => {
    // The widget already starts in a truthful offline/loading state.
  });

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
    setMonitorLogMetrics(env.settings.monitorLogMetrics);
  } catch {
    setMonitorLogToFile(false);
    setMonitorLogMetrics(undefined);
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
  store.set({ devices, latestSamples: {} });

  // M151: the first unified inventory snapshot can be empty while the
  // deferred Windows controller/backend enrichment is still in flight. Keep
  // this state mutable until sysinfo + the follow-up listDevices call land;
  // only the final enriched snapshot decides whether null/no-device mode is
  // real. A synthetic OS-only row is still a selectable GPU.
  let noDevice = devices.length === 0;
  // M4-F: the focused device id. It is null only while the inventory is
  // empty or when no non-ambiguous automatic target can be proven.
  let deviceId: number | null = null;
  let focusUnavailable = false;
  let persistedDeviceId: number | null = null;
  let persistedDeviceKey: string | null = null;
  const resolveFocusedDevice = async (availableDevices: typeof devices): Promise<void> => {
    noDevice = availableDevices.length === 0;
    if (noDevice) {
      deviceId = null;
      focusUnavailable = false;
      store.set({ deviceId: null });
      return;
    }
    let preferredDeviceId: number | null = null;
    let preferredDeviceKey: string | null = null;
    try {
      const persisted = await api.deviceGet();
      persistedDeviceId = persisted.deviceId;
      persistedDeviceKey = persisted.deviceKey ?? null;
    } catch {
      persistedDeviceId = null;
      persistedDeviceKey = null;
    }
    try {
      const preferred = await api.devicePreferredGet();
      preferredDeviceId = preferred?.deviceId ?? null;
      preferredDeviceKey = preferred?.deviceKey ?? null;
    } catch {
      // The resolver still preserves a valid persisted dGPU and otherwise
      // falls back to the safe discrete-first inventory order.
    }
    deviceId = resolveBootDevice(
      availableDevices,
      persistedDeviceId,
      persistedDeviceKey,
      preferredDeviceId,
      preferredDeviceKey,
    );
    focusUnavailable = deviceId === null;
    store.set({ deviceId });
  };
  if (!noDevice) await resolveFocusedDevice(devices);

  // App version for the header line (M2C-B B3). Failure degrades to the
  // initial placeholder - the header stays up.
  try {
    const v = await api.appVersion();
    store.set({ appVersion: v?.version ?? '0.0.0' });
  } catch {
    store.set({ appVersion: '0.0.0' });
  }
  setTitlebarVersion(store.get().appVersion);


  // M4-E: the distribution kind (app:build-info IPC) - the Settings
  // start-with-Windows hint differentiates by it. Failure degrades to 'dev'.
  try {
    const b = await api.appBuildInfo();
    store.set({ buildKind: b?.kind ?? 'dev' });
  } catch {
    store.set({ buildKind: 'dev' });
  }

  // M4N (A.1): the window-path boot apply's outcome record (kept for the
  // boot-apply verification contract). M16: the dashboard OC status row no
  // longer displays it - the row derives its stock-state verdict from the
  // driver read-back `state` (a status slot in the dashboard render
  // signature, so the row flips when the read-back lands/changes).
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

  // M4-D: the system info (dashboard CPU & memory card + the real-GPU
  // VRAM source). Fire-and-forget semantics: a failure degrades to null and
  // the card renders '-' rows; when the payload lands AFTER the first render
  // the dashboard sig (sysinfo slot) triggers the re-render.
  // M17p: the boot order is PINNED - sysinfo:get runs BEFORE
  // get-capabilities (below): the caps' deviceName comes from the
  // main-side in-place re-enrichment of the device array (setVramBytesOf
  // at the sysinfo landing), so firing get-capabilities first would read
  // the plain pre-enrichment names.
  // M17p: the devices re-fetch + ONE combined set - the window now opens
  // BEFORE the sysinfo query lands, so the boot enumeration above (~3 s
  // earlier) saw PLAIN device names. Re-fetch listDevices now that the CIM
  // payload landed and set BOTH in ONE store.set - a single set re-renders
  // once, no plain-name flicker. The no-Intel path is guarded: the
  // re-fetch there may now be the enriched inventory. If a non-empty first
  // snapshot is followed by a transient empty response, retain the known
  // inventory; an initially empty snapshot is allowed to recover to a
  // non-empty late result.
  let info = null;
  try {
    info = await api.sysinfo();
  } catch {
    info = null;
  }
  let freshDevices = devices;
  try {
    const candidateDevices = await api.listDevices();
    if (devices.length === 0 || candidateDevices.length > 0) freshDevices = candidateDevices;
  } catch {
    // keep the boot enumeration - the devices slot must never regress on a
    // transient re-fetch failure
  }
  store.set({ sysinfo: info ?? null, devices: freshDevices, latestSamples: {} });
  noDevice = freshDevices.length === 0;
  if (!noDevice) {
    // M151: the first inventory paint may precede the Windows controller
    // snapshot. Re-resolve after that enrichment so a display-driving dGPU
    // discovered late still becomes the focused adapter before caps/state and
    // telemetry are started. This also recovers from an initially empty list.
    try {
      await resolveFocusedDevice(freshDevices);
    } catch {
      // Keep the first safe selection when the late preference probe fails.
    }
  }
  // 1.0.1 no-Intel round: the OS GPU - the sysinfo PRIMARY non-basic video
  // controller (mirror matchVideoController's pick for a model-less device
  // name; pure helper). Set on the no-Intel path only (the Intel path
  // renders the IGCL device list instead). Lands in the SAME store.set as
  // the noIntel flag below so the dashboard GPU card re-renders once.
  const selectedAfterSysinfo = store.get().devices.find((d) => d.id === deviceId) ?? null;
  const osGpu = noDevice
    ? primaryVideoController(store.get().sysinfo)
    : selectedAfterSysinfo?.osController ?? null;

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
    // The mode is owned by the focused physical GPU. Reading the legacy
    // process-wide value here can resurrect another card's mode after boot.
    const m = await api.ocModeGet(deviceId);
    store.set({ ocMode: m?.ocMode === 'advanced' ? 'advanced' : 'stock' });
  } catch {
    store.set({ ocMode: 'stock' });
  }

  if (noDevice || focusUnavailable || deviceId === null) {
    // 1.0.1 no-Intel round: caps/state are SKIPPED on the no-device path
    // (they stay null - there is no IGCL device to read, and the waiver
    // prompt + the OC surface must never render). An all-ambiguous inventory
    // also stays un-focused rather than binding by ordinal.
  } else {
    try {
      pb('pre-caps');
      const caps = await api.getCapabilities(deviceId as number);
      const state = await api.getCurrentSettings(deviceId as number);
      store.set({ caps, state });
      pb('post-caps');
      // M4-B: the OC waiver prompt shows at EVERY startup while the waiver is
      // NOT accepted ("please prompt it when the Program opens").
      // M4-D (PERMANENT acceptance): a PERSISTED acceptance is the
      // user's permanent consent - the boot prompt is SKIPPED entirely then
      // (the accepted-state reminder dialog is REMOVED; the dashboard health
      // row remains the status display). The driver-side waiver state cannot
      // be probed from the renderer (IGCL exposes only ctlOverclockWaiverSet
      // - no getter), so the dialog at open is the only reliable visibility
      // for never-accepted sessions. NON-BLOCKING: the boot sequence
      // continues; a declined prompt must not break it. Accept patches the
      // store caps so the dashboard GPU Health card row flips to Accepted in
      // place.
      // M17 (B50-class): OC-locked devices (overclockingSupported === false)
      // have NO waiver - the driver refuses ctlOverclockWaiverSet with
      // ERROR_UNSUPPORTED_FEATURE. The prompt is skipped entirely there (a
      // prompt the user can never satisfy would toast on every boot).
      if (caps.waiverAccepted !== true && caps.overclockingSupported !== false) {
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
  const acceptTelemetrySample = (sample: TelemetrySample): void => {
    const live = store.get();
    const sampleKeys = [sample.deviceKey, ...(Array.isArray(sample.deviceKeys) ? sample.deviceKeys : [])]
      .filter((key): key is string => typeof key === 'string' && key.trim().length > 0);
    const matches = live.devices.filter((device) => {
      if (device.identityAmbiguous === true) return false;
      const deviceKeys = [device.deviceKey, ...(Array.isArray(device.deviceKeys) ? device.deviceKeys : []), deviceHardwareKey(device)]
        .filter((key): key is string => typeof key === 'string' && key.trim().length > 0);
      return sampleKeys.some((key) => deviceKeys.includes(key));
    });
    const target = matches.length === 1
      ? matches[0]
      : sampleKeys.length === 0 && Number.isInteger(sample.deviceId)
        ? live.devices.find((device) => device.id === sample.deviceId && device.identityAmbiguous !== true) ?? null
        : null;
    const isSystemSample = target === null
      && (sample.deviceId === undefined || sample.deviceId === null)
      && live.deviceId === null;
    if (!target && !isSystemSample) return;

    if (isSystemSample) {
      store.set({ latestSample: sample });
    } else if (target) {
      store.set({
        latestSamples: {
          ...live.latestSamples,
          [target.deviceKey ?? deviceHardwareKey(target)]: sample,
        },
        ...(target.id === live.deviceId ? { latestSample: sample } : {}),
      });
    }
    if (getMonitorLogToFile()) {
      void api.monitorLogAppend(filterMonitorLogSample({
        ...sample,
        ...getLatestFpsSample(),
        memoryCapacityBytes: live.sysinfo?.ram.totalBytes ?? null,
      }) as unknown as TelemetrySample & { fps?: number | null })
        .catch(() => { /* a failed append never breaks the UI */ });
    }
  };
  api.onTelemetrySample(acceptTelemetrySample);

  // M16-F1 (D2): the tray "Apply active profile" runs ENTIRELY in main -
  // this subscription receives the pushed post-apply read-back
  // (device:state-updated) and refreshes the store `state` slot so the
  // dashboard OC status row (derived from the live read-back) flips in
  // place after a tray apply - "an apply from ANY path refreshes the store
  // state" (the documented M16 refresh contract). Guarded like the other
  // pushed paths: only a NON-NULL state for the CURRENT device replaces
  // the slot (the tray apply targets the persisted/selected device - a
  // mismatch must never clobber the live view).
  api.onStateUpdated((payload) => {
    if (!payload?.state) return;
    const live = store.get();
    if (live.deviceId === payload.deviceId) store.set({ state: payload.state });
  });

  if (noDevice) {
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
    await configureDashboardTelemetry(null, []);
    // M17d (round-1 S2): the vendor-lane static info (the no-Intel
    // dashboard VRAM/Compute rows' source - { vramBytes, computeCores }:
    // the NVML total + core count; honest nulls when the lane has no
    // source). Fire-and-forget like sysinfo: a failure degrades to null and
    // the rows render the honest fallback; a late landing re-renders the
    // GPU card via the dashboard sig (the vendorInfo slot).
    try {
      const info = await api.vendorInfo();
      store.set({ vendorInfo: info ?? null });
    } catch {
      store.set({ vendorInfo: null });
    }
    // S1: the noIntel store flag lands AFTER the null-mode start (and in
    // the same set as osGpu so the dashboard GPU card re-renders once).
    store.set({ noIntel: true, osGpu });
    console.log('[renderer] boot complete - no Intel GPU');
    pb('boot-complete');
  } else if (focusUnavailable || deviceId === null) {
    // No safe automatic target exists. Keep CPU/OS telemetry available while
    // leaving the GPU-scoped dashboard fields honest instead of selecting an
    // ambiguous row by enumeration order.
    try { await api.telemetryStart(null); } catch { /* OS telemetry is best effort */ }
    await configureDashboardTelemetry(null, []);
    store.set({ noIntel: false, osGpu: null, vendorInfo: null });
    console.log('[renderer] boot complete - no safe automatic GPU focus');
    pb('boot-complete');
  } else {
    try {
      await api.telemetryStart(deviceId as number);
      await configureDashboardTelemetry(deviceId, store.get().devices);
      // M151: hydrate from main's latest per-device snapshot as well as the
      // push. This closes the startup window where another renderer created
      // the lane before this listener was registered.
      try {
        const initialSample = await api.telemetryLatest(deviceId as number);
        if (initialSample) acceptTelemetrySample(initialSample);
      } catch {
        // The live push remains the normal path; a snapshot failure is honest
        // and must not make the whole boot fail.
      }
    } catch (err) {
      toast('warn', 'Telemetry unavailable', err instanceof Error ? err.message : String(err));
    }

    const selected = store.get().devices.find((d) => d.id === deviceId) ?? null;
    // M30: `noIntel` is the machine-level empty-inventory mode, not a
    // selected-device capability. An OS-only AMD/NVIDIA row beside an IGCL
    // adapter remains a normal selected GPU with unsupported controls.
    store.set({ noIntel: false, osGpu: selected?.osController ?? null });
    // M30: static vendor info is selected-device scoped. It is useful for an
    // OS-only NVIDIA/AMD row and harmlessly returns null for IGCL rows.
    try {
      const info = await api.vendorInfo(deviceId as number);
      store.set({ vendorInfo: info ?? null });
    } catch {
      store.set({ vendorInfo: null });
    }
    console.log(`[renderer] boot complete - device ${deviceId}${health?.backend === 'mock' ? ' (mock)' : ''}`);
    pb('boot-complete');
  }
}

void boot().finally(() => {
  mainBootComplete = true;
  const queuedKey = queuedDeviceSelectionKey;
  queuedDeviceSelectionKey = null;
  if (queuedKey !== null) requestDeviceSelection(queuedKey);
});
