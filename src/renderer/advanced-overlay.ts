// Arc Power - M23 the ADVANCED overlay renderer (the interactive side panel
// window: the AMD-Adrenaline-style control surface). Compact, three tabs:
//   - Tuning: the scalar OC slider cards (powerLimitW, gpuFreqOffsetMhz,
//     gpuVoltOffsetV, tempLimitC, vramFreqOffsetGts, vramVoltOffsetV -
//     gated by caps.controls; PL is EDITABLE like the main Tuning page - the
//     user's PL rule was about the M22 FIX never touching HOW PL is applied,
//     not about hiding PL from the panel). The Fixed Clock / Voltage Lock
//     editor is NOT part of the panel (the user's directive: a gpuLock change
//     risks the driver's lock-mode crash on this card, and the panel must fit
//     without scrolling) - the MAIN window's Tuning page keeps the M22-safe
//     lock editor. The slider cards show ONLY the value + the range caption
//     (no step info, no "Driver:" readout - the dirty chip + the Apply
//     button already signal an unapplied change) + the per-card chips + a
//     floating Apply (the Apply-button model, never live-drag);
//   - Fan: the EXISTING fan editor reused DIRECTLY (renderFanEditor) via a
//     PageContext shim ({ store: { get, set } } backed by the panel's own
//     state fetch) - never re-implemented;
//   - Graphics: the four M8 cards via api.graphicsGet + api.graphicsApply
//     with the option lists EXPORTED from pages/graphics.ts
//     (DROPDOWN_OPTIONS / DROPDOWN_LABELS / CARD_TITLES - export, never
//     duplicate; CARD_NOTES is NOT imported - the panel shows no long notes,
//     the user's directive); the supported-features caps gate each card.
//
// The panel boots with the app.ts fetch sequence (deviceGet ->
// getCapabilities -> getCurrentSettings -> render the active tab);
// onStateUpdated + the telemetry push refresh the readout strip + the chips
// in place. Honest states: deviceId null -> 'No GPU available.'; caps/state
// null -> the loading note; the no-fan/read-only fan notes (the fan editor
// renders them).
//
// The panel defaults to the dark design language (Part B §Design) - the
// header (Arc logo + the "Arc Power" wordmark + the LIVE readout strip:
// clock/temp/fan/power from the telemetry sample, honest '-' per field) +
// the drag region + the close button; the compact footer shows the device
// name only (the lock readout is gone - it was useless without the editor).

import { el, clear } from './dom.ts';
import { api } from './ipc.ts';
import { toast } from './components/toast.ts';
import { ensureWaiver } from './components/waiver-dialog.ts';
import { Store } from './router.ts';
import { buildDeviceSelect } from './components/device-select.ts';
import type { PageContext } from './router.ts';
import type { Capabilities, DeviceInfo, DeviceState, GraphicsSettings, GraphicsState, TelemetrySample } from './types.ts';
import {
  snapToRange,
  normalizedPosition,
  formatValue,
  controlDisplay,
  controlDisplayRange,
  controlValueFromDisplay,
  controlValueToDisplay,
} from './pure/slider.ts';
import {
  buildScalarSettings,
  validateSettingsPayload,
  isScalarDirtyVsApplied,
  computeDirtyVsApplied,
  cardSliderRange,
} from './pure/settings.ts';
import { applyFailureText, CONTROL_LABELS } from './pure/errors.ts';
import {
  normalizeDeviceKey,
  resolveBootDevice,
  resolveSelectionDevice,
  telemetryMatchesSelection,
} from './pure/device.ts';
import { chipState } from './pure/chip.ts';
import { renderFanEditor, updateFanReadout } from './pages/fan-editor.ts';
import {
  CARD_TITLES,
  DROPDOWN_LABELS,
  DROPDOWN_OPTIONS,
  GRAPHICS_RESET_DEFAULTS,
} from './pages/graphics.ts';
import {
  isGraphicsControlSupported,
  frameLimitRange,
  clampFrameLimitValue,
  normalizeGraphicsSettings,
  validateGraphicsSettings,
  computeGraphicsDirty,
  buildGraphicsSettings,
  isGraphicsControlDirtyVsApplied,
} from './pure/graphics.ts';
import { isValidTheme } from './pure/theme.ts';
import { formatGpuMemoryGb, gpuMemoryLabel } from './pure/gpu-memory.ts';
import { normalizeOverlayStats } from './pure/overlay.ts';

// ---------------------------------------------------------------------------
// The panel store + boot state
// ---------------------------------------------------------------------------

const store = new Store();
let activeTab: 'tuning' | 'fan' | 'graphics' = 'tuning';

// A selection push is the panel's ownership boundary. Every device identity
// change advances this generation so async reads/applies from the old panel
// cannot commit into the newly selected device.
type PanelSelection = { deviceId: number; deviceKey: string | null; caps: Capabilities; state: DeviceState };
let panelGeneration = 0;
let pendingSelection: PanelSelection | null = null;

function selectedDeviceKey(state: ReturnType<Store['get']>): string | null {
  const selected = state.devices.find((device) => device.id === state.deviceId);
  return normalizeDeviceKey(selected?.deviceKey) ?? normalizeDeviceKey(state.caps?.deviceKey);
}

function panelIdentityMatches(deviceId: number, deviceKey: string | null, generation: number): boolean {
  const live = store.get();
  return generation === panelGeneration
    && live.deviceId === deviceId
    && selectedDeviceKey(live) === deviceKey;
}

const contentEl = document.getElementById('adv-content') as HTMLElement;
const deviceEl = document.getElementById('adv-device') as HTMLElement;
const clockEl = document.getElementById('adv-readout-clock') as HTMLElement;
const tempEl = document.getElementById('adv-readout-temp') as HTMLElement;
const fanEl = document.getElementById('adv-readout-fan') as HTMLElement;
const powerEl = document.getElementById('adv-readout-power') as HTMLElement;
const memoryLabelEl = document.getElementById('adv-readout-memory-label') as HTMLElement;
const memoryEl = document.getElementById('adv-readout-memory') as HTMLElement;
const closeBtn = document.getElementById('adv-close') as HTMLButtonElement;
let monitoredStats = normalizeOverlayStats(undefined);
let telemetryRetryTimer: number | null = null;

function stopTelemetryRetry(): void {
  if (telemetryRetryTimer === null) return;
  window.clearInterval(telemetryRetryTimer);
  telemetryRetryTimer = null;
}

function applyAdvancedTheme(theme: string): void {
  const normalized = isValidTheme(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = normalized;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('theme', normalized);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Keep the bootstrap theme in constrained test harnesses.
  }
}

// The main process pushes the persisted software theme on initial load and
// after every settings save. Basic Overlay classic/arc state is unrelated.
function applyReadoutVisibility(): void {
  document.querySelectorAll<HTMLElement>('.adv-readout-cell[data-stat-id]').forEach((cell) => {
    cell.hidden = !monitoredStats.includes(cell.dataset.statId ?? '');
  });
}

api.onAdvancedOverlaySettings((settings) => {
  monitoredStats = normalizeOverlayStats(settings?.stats);
  applyAdvancedTheme(settings?.theme);
  applyReadoutVisibility();
});

applyReadoutVisibility();

closeBtn.addEventListener('click', () => {
  void api.advancedOverlayClose();
});

// The live clock tick (the readout strip's Time cell - accent-tinted,
// updated once per second).
setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}, 1000);
clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The telemetry push - the THIRD consumer of the sample stream (ipc.js
// forwards to the panel window). Refreshes the readout strip + the
// fan editor's RPM marker in place.
function acceptTelemetrySample(sample: TelemetrySample | null, deviceId: number, generation: number): boolean {
  if (!sample) return false;
  const live = store.get();
  if (!panelIdentityMatches(deviceId, selectedDeviceKey(live), generation)) return false;
  const selected = live.devices.find((device) => device.id === live.deviceId);
  const sampleKey = normalizeDeviceKey(sample.deviceKey);
  // Capabilities come from the same main-process target as telemetry and are
  // authoritative when inventory numbering or labels change.
  const selectedKey = normalizeDeviceKey(live.caps?.deviceKey) ?? normalizeDeviceKey(selected?.deviceKey);
  const sampleAliases = Array.isArray(sample.deviceKeys) ? sample.deviceKeys : [];
  const selectedAliases = [
    ...(Array.isArray(live.caps?.deviceKeys) ? live.caps.deviceKeys : []),
    ...(Array.isArray(selected?.deviceKeys) ? selected.deviceKeys : []),
  ];
  // Prefer durable identity when both sides provide it. Some OS-only or
  // older inventory rows have no durable key even though their session-local
  // numeric id is authoritative; reject only a real id/key mismatch so the
  // panel does not stay blank on those machines while the main dashboard is
  // already receiving the same sample.
  const identityMatches = telemetryMatchesSelection(
    sample.deviceId,
    sampleKey,
    live.deviceId,
    selectedKey,
    sampleAliases,
    selectedAliases,
  );
  if (!identityMatches) return false;
  store.set({ latestSample: sample });
  renderReadout(sample);
  if (activeTab === 'fan') {
    updateFanReadout(contentEl, { store });
  }
  stopTelemetryRetry();
  return true;
}

api.onTelemetrySample((sample) => {
  const live = store.get();
  if (typeof live.deviceId !== 'number') return;
  acceptTelemetrySample(sample, live.deviceId, panelGeneration);
});

// The post-apply device read-back push (the tray/profile apply path).
// M24 (fix): the panel's own apply already handles state updates via
// renderTuningInPlace - a full re-render from the push causes a race
// (the push arrives before applied[] is set, so the rebuilt chips show
// 'dirty' instead of 'applied'). Just update the store; the next tab
// switch or explicit render picks up the fresh state.
api.onStateUpdated((payload) => {
  const live = store.get();
  // State pushes carry the originating session id; never let a read-back from
  // another device overwrite the selected device's state.
  if (!payload || !payload.state || payload.deviceId !== live.deviceId) return;
  store.set({ state: payload.state });
});
// M31: one atomic main-owned selection push updates the panel's current
// inventory, durable selection, and matching caps/state pair. The panel
// never starts/stops telemetry and never persists directly.
let selectionPushSerial = 0;

function applyDeviceSelectionPush(payload: PanelSelection, devices: DeviceInfo[]): boolean {
  const target = resolveSelectionDevice(devices, payload.deviceId, payload.deviceKey);
  if (!target) return false;
  const nextKey = normalizeDeviceKey(target.deviceKey);
  const live = store.get();
  const changed = live.deviceId !== target.id || selectedDeviceKey(live) !== nextKey;
  if (changed) panelGeneration += 1;
  store.set({
    devices,
    deviceId: target.id,
    caps: payload.caps,
    state: payload.state,
    latestSample: null,
  });
  deviceEl.textContent = payload.caps.deviceName || target.name || 'Unknown GPU';
  values = {};
  applied = {};
  applying = false;
  tuningApplyBtn = null;
  graphicsState = null;
  graphicsStateGeneration = -1;
  graphicsDraft = {};
  graphicsApplied = {};
  graphicsApplying = false;
  graphicsApplyBtn = null;
  stopTelemetryRetry();
  renderReadout(null);
  renderTab();
  return true;
}

function editableNumber(value: number, range: { step: number; units: string }): string {
  const decimals = Number.isInteger(range.step)
    ? 0
    : Math.min(6, String(range.step).split('.')[1]?.length ?? 3);
  return value.toFixed(decimals);
}

api.onDeviceSelectionUpdated((payload) => {
  pendingSelection = payload;
  const serial = ++selectionPushSerial;
  // The main renderer owns the authoritative inventory. Re-enumerate here so
  // a durable-key push can map a renumbered device to its new session id.
  void api.listDevices().then((devices) => {
    if (serial !== selectionPushSerial) return;
    if (applyDeviceSelectionPush(payload, devices) && pendingSelection === payload) pendingSelection = null;
  }).catch(() => { /* retain pendingSelection for the boot handshake */ });
});

// M24 (Part B): pushed POST-APPLY GRAPHICS read-backs (the twin of
// onStateUpdated for the graphics surface). Ignore pushes from an older
// panel generation even when session ids are reused.
api.onGraphicsStateUpdated((payload) => {
  if (payload && payload.deviceId === store.get().deviceId && graphicsStateGeneration === panelGeneration) {
    graphicsState = payload.graphicsState;
    if (activeTab === 'graphics' && !graphicsApplying) renderGraphics();
  }
});


function renderReadout(sample: TelemetrySample | null): void {
  const s: Partial<TelemetrySample> = sample ?? {};
  const temp = typeof s.tempC === 'number' && Number.isFinite(s.tempC) ? s.tempC : null;
  const fan = Array.isArray(s.fanRpm) && typeof s.fanRpm[0] === 'number' && Number.isFinite(s.fanRpm[0]) ? s.fanRpm[0] : null;
  const power = typeof s.powerW === 'number' && Number.isFinite(s.powerW) ? s.powerW : null;
  tempEl.textContent = temp === null ? '-' : `${Math.round(temp)}°C`;
  fanEl.textContent = fan === null ? '-' : `${Math.round(fan)} RPM`;
  powerEl.textContent = power === null ? '-' : `${power.toFixed(1)} W`;
  memoryLabelEl.textContent = gpuMemoryLabel(s.gpuMemorySource);
  const memory = formatGpuMemoryGb(s.gpuMemUsedBytes);
  memoryEl.textContent = memory === '-' ? '-' : `${memory} GB`;
}

// The push stream is the normal live path, but the panel can be opened after
// the main telemetry lane's last tick. Read the main-process snapshot once so
// the header is populated immediately, then let pushes keep it current.
async function syncLatestTelemetry(deviceId: number, generation: number): Promise<void> {
  try {
    const sample = await api.telemetryLatest(deviceId);
    acceptTelemetrySample(sample, deviceId, generation);
  } catch {
    // The snapshot is a convenience for startup; the push stream remains
    // authoritative if this optional read is unavailable.
  }
}

function scheduleTelemetryRetry(deviceId: number, generation: number): void {
  stopTelemetryRetry();
  let attempts = 0;
  telemetryRetryTimer = window.setInterval(() => {
    attempts += 1;
    if (attempts > 20 || !panelIdentityMatches(deviceId, selectedDeviceKey(store.get()), generation)) {
      stopTelemetryRetry();
      return;
    }
    void syncLatestTelemetry(deviceId, generation);
  }, 500);
}

// ---------------------------------------------------------------------------
// Boot: deviceGet -> getCapabilities -> getCurrentSettings -> render
// ---------------------------------------------------------------------------

async function resolveAdvancedOverlaySelection(): Promise<{ devices: DeviceInfo[]; deviceId: number | null }> {
  let persisted: { deviceId?: number | null; deviceKey?: string | null } | null = null;
  try {
    persisted = await api.deviceGet();
  } catch {
    return { devices: [], deviceId: null };
  }
  let devices: DeviceInfo[] = [];
  try {
    devices = await api.listDevices();
  } catch {
    return { devices, deviceId: null };
  }
  let preferred: { deviceId?: number | null; deviceKey?: string | null } | null = null;
  try {
    preferred = await api.devicePreferredGet();
  } catch {
    // Older or unavailable backends keep the persisted-selection fallback.
  }
  const fallback = typeof persisted?.deviceId === 'number' && persisted.deviceId >= 0
    ? persisted.deviceId
    : null;
  return {
    devices,
    deviceId: resolveBootDevice(
      devices,
      fallback,
      persisted?.deviceKey ?? null,
      preferred?.deviceId ?? null,
      preferred?.deviceKey ?? null,
    ),
  };
}

async function boot(): Promise<void> {
  const bootGeneration = panelGeneration;
  const selection = await resolveAdvancedOverlaySelection();
  const pushed = pendingSelection;
  pendingSelection = null;
  const pushedTarget = pushed && resolveSelectionDevice(selection.devices, pushed.deviceId, pushed.deviceKey);
  if (pushed && pushedTarget) {
    selectionPushSerial += 1;
    store.set({
      devices: selection.devices,
      deviceId: pushedTarget.id,
      caps: pushed.caps,
      state: pushed.state,
    });
    deviceEl.textContent = pushed.caps.deviceName || pushedTarget.name || 'Unknown GPU';
    renderTab();
    await syncLatestTelemetry(pushedTarget.id, panelGeneration);
    if (!store.get().latestSample) scheduleTelemetryRetry(pushedTarget.id, panelGeneration);
    return;
  }
  // A selection that arrived while the initial enumeration was in flight
  // invalidates the old boot result; do not overwrite the main-owned push.
  if (panelGeneration !== bootGeneration) return;
  const deviceId = selection.deviceId;
  store.set({ devices: selection.devices, deviceId });

  if (deviceId === null) {
    deviceEl.textContent = 'No GPU available.';
    stopTelemetryRetry();
    renderReadout(null);
    renderTab();
    return;
  }

  const deviceKey = selectedDeviceKey(store.get());
  let caps: Capabilities | null = null;
  let state: DeviceState | null = null;
  try {
    caps = await api.getCapabilities(deviceId);
    state = await api.getCurrentSettings(deviceId);
  } catch {
    caps = null;
    state = null;
  }
  if (!panelIdentityMatches(deviceId, deviceKey, bootGeneration)) return;
  store.set({ caps, state });
  deviceEl.textContent = caps?.deviceName || 'Unknown GPU';
  renderTab();
  await syncLatestTelemetry(deviceId, bootGeneration);
  if (!store.get().latestSample) scheduleTelemetryRetry(deviceId, bootGeneration);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function renderTab(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.adv-tab');
  for (const t of tabs) {
    const on = t.dataset.tab === activeTab;
    t.classList.toggle('adv-tab-active', on);
    t.setAttribute('aria-selected', String(on));
  }
  clear(contentEl);
  if (activeTab === 'tuning') {
    // M24 (fix): reset the tuning state ONLY on tab switch (not on
    // onStateUpdated push re-renders, which call renderTuning directly).
    values = {};
    applied = {};
    applying = false;
    tuningApplyBtn = null;
    void renderTuning();
  }
  else if (activeTab === 'fan') renderFan();
  else void renderGraphics();
}

document.querySelectorAll<HTMLButtonElement>('.adv-tab').forEach((t) => {
  t.addEventListener('click', () => {
    const tab = t.dataset.tab;
    if (tab === 'tuning' || tab === 'fan' || tab === 'graphics') {
      activeTab = tab;
      renderTab();
    }
  });
});

// ---------------------------------------------------------------------------
// Tuning tab - the scalar slider cards (incl. the EDITABLE power limit) +
// the M22-safe lock editor + the floating Apply (Apply-button model)
// The scalar cards (the panel's set - PL IS included: editable like the
// main Tuning page; the PL1/PL2 sysman readout rides its card's meta line).
// Gated by caps.controls like the main Tuning page.  The visible units use the
// same Battlemage presentation conversion as the main Tuning page while the
// apply payload keeps the driver's raw capability units.
const SCALAR_CONTROLS = ['powerLimitW', 'gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'tempLimitC', 'vramFreqOffsetGts', 'vramVoltOffsetV'];

let values: Record<string, number> = {};
let applied: Record<string, number> = {};
let hiddenNegativeControls = new Set<string>();
let applying = false;
let tuningApplyBtn: HTMLButtonElement | null = null;

async function renderTuning(): Promise<void> {
  clear(contentEl);
  const s = store.get();
  const caps = s.caps;
  const state = s.state;
  const view = el('div', { class: 'adv-view tuning-view' });
  const deviceSelect = buildDeviceSelect(store, (id) => {
    const selected = store.get().devices.find((device) => device.id === id);
    if (selected?.deviceKey) {
      void api.deviceSelectionRequest(selected.deviceKey);
    } else {
      toast('warn', 'GPU selection unavailable', 'This GPU has no stable identity and cannot be selected safely.');
    }
  });
  const tuningHeading = el('div', { class: 'adv-view-heading' }, [
    el('p', { class: 'adv-view-title', text: 'Tuning' }),
    ...(deviceSelect ? [deviceSelect] : []),
  ]);

  if (s.deviceId === null) {
    view.append(tuningHeading, el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
    contentEl.append(view);
    return;
  }
  if (!caps || !state) {
    view.append(tuningHeading, el('p', { class: 'page-subtitle', text: 'Loading device capabilities…' }));
    contentEl.append(view);
    return;
  }
  if (caps.overclockingSupported === false) {
    view.append(tuningHeading, el('p', { class: 'page-subtitle', text: 'Tuning is not supported on this GPU. Telemetry remains available.' }));
    contentEl.append(view);
    return;
  }

  // The mutable current state (the main Tuning page's pattern): every apply
  // refreshes it from the envelope so the driver readouts + the chips never
  // go stale in place.
  let currentState: DeviceState = state;

  // Gated on the RANGE presence (the main Tuning page's supportedScalars
  // convention - caps.controls keys are the plain CONTROL names
  // (gpuFreqOffset/gpuVoltOffset/...), never the canonical range keys; a
  const controls = SCALAR_CONTROLS.filter((key) => {
    const range = cardSliderRange(caps, key);
    // A capability range is the source of support; the visible unit is
    // converted below for Battlemage while the apply value stays raw.
    return range !== undefined;
  });
  hiddenNegativeControls = new Set<string>();
  for (const key of controls) {
    const cur = currentState[key as keyof DeviceState];
    const range = cardSliderRange(caps, key);
    if (!range) continue;
    if (key === 'gpuVoltOffsetV' && range.units === 'V' && typeof cur === 'number' && cur < 0) hiddenNegativeControls.add(key);
    values[key] = snapToRange(typeof cur === 'number' ? cur : range.default, range);
  }

  const stack = el('div', { class: 'card-stack oc-stack' });

  const updateFloating = (): void => {
    if (!tuningApplyBtn) return;
    if (applying) { tuningApplyBtn.hidden = false; return; }
    tuningApplyBtn.hidden = !computeDirtyVsApplied(buildScalarSettings(values, { hiddenNegativeControls }), currentState, applied, hiddenNegativeControls);
  };

  const setBusy = (busy: boolean): void => {
    applying = busy;
    if (tuningApplyBtn) {
      tuningApplyBtn.disabled = busy;
      tuningApplyBtn.textContent = busy ? 'Applying…' : 'Apply';
    }
  };

  // The scalar slider cards (the Tuning page's compact pattern).
  const buildCard = (key: string): HTMLElement => {
    const range = cardSliderRange(caps, key) as NonNullable<ReturnType<typeof cardSliderRange>>;
    const display = controlDisplay(key, range, caps.deviceName);
    const displayRange = controlDisplayRange(key, range, caps.deviceName);
    const visibleValue = (): number => controlValueToDisplay(values[key], key, range, caps.deviceName);
    const visibleNumber = (value: number): string => display.decimals === 0
      ? String(Math.round(value))
      : value.toFixed(Math.min(6, String(displayRange.step).split('.')[1]?.length ?? 3));
    const valueInput = el('input', {
      type: 'number',
      class: 'oc-value-input',
      min: String(displayRange.min),
      max: String(displayRange.max),
      step: String(displayRange.step),
      value: editableNumber(visibleValue(), displayRange),
      'aria-label': `${CONTROL_LABELS[key] ?? key} value`,
      onchange: (ev: Event) => {
        const visible = Number((ev.target as HTMLInputElement).value);
        if (!Number.isFinite(visible)) return;
        hiddenNegativeControls.delete(key);
        values[key] = snapToRange(controlValueFromDisplay(visible, key, range, caps.deviceName), range);
        const shown = visibleValue();
        valueInput.value = editableNumber(shown, displayRange);
        valueNode.textContent = formatValue(shown, display.units, display.decimals);
        slider.value = String(shown);
        fill.style.width = `${normalizedPosition(shown, displayRange) * 100}%`;
        refreshChip(key);
        updateFloating();
      },
    }) as HTMLInputElement;
    const valueField = el('div', { class: 'oc-value-field' }, [
      valueInput,
      el('span', { class: 'oc-value-unit', text: display.units === 'C' ? '°C' : display.units }),
    ]);
    // Keep the established text node for the panel's verification contract;
    // the editable input is the visible control.
    const valueNode = el('span', { class: 'oc-value', text: formatValue(visibleValue(), display.units, display.decimals), 'aria-hidden': 'true' });
    const rangeNode = el('span', { class: 'oc-range', text: `${visibleNumber(displayRange.min)} – ${visibleNumber(displayRange.max)} ${display.units}` });
    const fill = el('div', { class: 'oc-track-fill' });
    fill.style.width = `${normalizedPosition(visibleValue(), displayRange) * 100}%`;
    const slider = el('input', {
      type: 'range',
      min: String(displayRange.min),
      max: String(displayRange.max),
      step: String(displayRange.step),
      value: String(visibleValue()),
      oninput: (ev: Event) => {
        const visible = Number((ev.target as HTMLInputElement).value);
        const v = snapToRange(controlValueFromDisplay(visible, key, range, caps.deviceName), range);
        hiddenNegativeControls.delete(key);
        values[key] = v;
        const shown = controlValueToDisplay(v, key, range, caps.deviceName);
        valueNode.textContent = formatValue(shown, display.units, display.decimals);
        valueInput.value = editableNumber(shown, displayRange);
        fill.style.width = `${normalizedPosition(shown, displayRange) * 100}%`;
        refreshChip(key);
        updateFloating();
      },
    });
    const chip = el('span', { class: 'chip oc-chip-status', hidden: true });
    const chipApply = el('button', {
      class: 'chip chip-btn oc-chip-apply',
      hidden: true,
      text: 'Apply',
      onClick: () => {
        if (applying) return;
        void applyScalar(key);
      },
    });
    const refreshChip = (k: string): void => {
      const rawDriver = currentState[k as keyof DeviceState];
      const driver = hiddenNegativeControls.has(k) && k === 'gpuVoltOffsetV'
        && typeof rawDriver === 'number' && rawDriver < 0 && !(k in applied) ? 0 : rawDriver;
      const st = chipState(k, values, applied, driver, true);
      chip.hidden = st !== 'applied';
      if (st === 'applied') {
        chip.textContent = 'Applied';
        chip.className = 'chip oc-chip-status chip-ok';
      } else {
        chip.textContent = '';
        chip.className = 'chip oc-chip-status';
      }
      chipApply.hidden = st !== 'dirty';
    };
    const card = el('section', { class: 'card oc-card', dataset: { control: key } }, [
      el('div', { class: 'oc-card-head' }, [
        el('h2', { class: 'card-title', text: CONTROL_LABELS[key] ?? key }),
        valueField,
        valueNode,
      ]),
      el('div', { class: 'oc-slider-row' }, [
        el('div', { class: 'oc-slider' }, [fill, slider]),
      ]),
      // M23 (user): the chips (Applied / Apply) ride the SAME row as the
      // range note, right-aligned - the old separate actions row dragged
      // out the card height.
      el('div', { class: 'oc-meta' }, [
        rangeNode,
        el('span', { class: 'oc-meta-spacer' }),
        chip,
        chipApply,
      ]),
    ]);
    refreshChip(key);
    return card;
  };

  // The power-limit card: a REAL slider card (editable - the user's PL rule
  // was about the M22 FIX never touching HOW PL is applied, not about hiding
  // PL from the panel; the main Tuning page's PL slider is a real applyable
  // control, so the panel mirrors it). M23 (user): NO PL1/PL2 sysman readout
  // line - the panel PL card stays as simple as the other slider cards.
  const buildPlCard = (): HTMLElement => buildCard('powerLimitW');

  // M23 (user): the Fixed Clock / Voltage Lock editor is NOT part of the
  // overlay's Tuning tab - a gpuLock change risks the driver's lock-mode
  // crash on this card, and the panel must fit without scrolling. The MAIN
  // window's Tuning page keeps its M22-safe lock editor (0/0 = offset reset,
  // only a real non-zero pair ever writes the lock API).

  // The floating Apply (the Apply-button model) - applies every dirty
  // scalar control (the M22-fixed payloads ride the same channel: offset
  // applies carry NO gpuLock - the panel can never write {0,0} to the
  // driver).
  tuningApplyBtn = el('button', { class: 'btn btn-primary adv-floating-apply', text: 'Apply', hidden: true });
  tuningApplyBtn.addEventListener('click', () => {
    if (applying) return;
    void applyScalar();
  });
  const tuningResetBtn = el('button', {
    class: 'btn btn-ghost btn-sm',
    text: 'Reset to default',
    onClick: () => {
      applied = {};
      hiddenNegativeControls = new Set<string>();
      for (const key of controls) {
        const range = cardSliderRange(caps, key);
        if (range) values[key] = snapToRange(range.default, range);
      }
      renderTuningInPlace();
      updateFloating();
    },
  });
  const tuningActions = el('div', { class: 'graphics-general-actions tuning-general-actions' }, [tuningApplyBtn, tuningResetBtn]);

  const applyScalar = async (only?: string): Promise<void> => {
    const live = store.get();
    const deviceId = live.deviceId;
    const deviceKey = selectedDeviceKey(live);
    const generation = panelGeneration;
    if (deviceId === null || !caps) return;
    let settings;
    if (only !== undefined) {
      settings = buildScalarSettings({ [only]: values[only] }, { hiddenNegativeControls });
    } else {
      settings = buildScalarSettings(values, { hiddenNegativeControls });
    }
    if (!validateSettingsPayload(settings)) {
      toast('error', 'Apply aborted', 'The settings payload failed validation - this is a bug.');
      return;
    }
    // M2C-C: a non-elevated product app delegates to the elevated
    // self-worker - explain BEFORE the prompt (the workerApply pattern).
    if (live.workerApply && !live.elevated && panelIdentityMatches(deviceId, deviceKey, generation)) {
      toast('info', 'Administrator approval needed', 'Administrator approval is needed to apply GPU settings.');
    }
    const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, caps.deviceName || 'this GPU', live.caps?.overclockingSupported !== false);
    if (!panelIdentityMatches(deviceId, deviceKey, generation)) return;
    if (decision === 'cancelled') {
      toast('info', 'Apply cancelled', 'The warranty waiver must be accepted before overclocking.');
      return;
    }
    {
      const cur = store.get();
      if (cur.caps && cur.caps.waiverAccepted !== true) {
        store.set({ caps: { ...cur.caps, waiverAccepted: true } });
      }
    }
    setBusy(true);
    try {
      const { result, state: fresh } = await api.applySettings(deviceId, settings);
      // A driver write is intentionally not cancelled, but its response is
      // ignored once the panel moved to another device/generation.
      if (!panelIdentityMatches(deviceId, deviceKey, generation)) return;
      // M24 (fix): set the applied reference BEFORE store.set - the M24
      // sync push fires onStateUpdated → renderTuning() which clears +
      // rebuilds the DOM; if applied is not yet set, the rebuilt chips
      // show 'dirty' instead of 'applied'.
      for (const [key, per] of Object.entries(result.perControl)) {
        if (per.ok) {
          const wanted = (settings as Record<string, unknown>)[key];
          if (typeof wanted === 'number') applied[key] = wanted;
        }
      }
      if (fresh) {
        currentState = fresh;
        store.set({ state: fresh });
      }
      for (const [key, per] of Object.entries(result.perControl)) {
        if (per.ok) {
          toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        } else {
          // M22: the apply-while-locked refusal (the driver's locked-mode
          // class) surfaces through the shared applyFailureText - honest,
          // never a lie.
          toast('error', `${CONTROL_LABELS[key] ?? key} failed`, applyFailureText(per, key));
        }
      }
      if (fresh) renderTuningInPlace();
    } catch (err) {
      if (panelIdentityMatches(deviceId, deviceKey, generation)) {
        toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Selection reset the old busy state; do not touch a new panel's Apply
      // button while balancing a stale response.
      if (panelIdentityMatches(deviceId, deviceKey, generation)) {
        setBusy(false);
        updateFloating();
      }
    }
  };

  // Re-render the cards in place (the chips + the driver readouts follow
  // the fresh state without a full re-render).
  const renderTuningInPlace = (): void => {
    if (!currentState) return;
    for (const key of controls) {
      const card = stack.querySelector<HTMLElement>(`.oc-card[data-control="${key}"]`);
      if (!card) continue;
      const range = cardSliderRange(caps, key);
      if (!range) continue;
      const slider = card.querySelector<HTMLInputElement>('input[type="range"]');
      const fill = card.querySelector<HTMLElement>('.oc-track-fill');
      const valueNode = card.querySelector<HTMLElement>('.oc-value');
      const valueInput = card.querySelector<HTMLInputElement>('.oc-value-input');
      const display = controlDisplay(key, range, caps.deviceName);
      const displayRange = controlDisplayRange(key, range, caps.deviceName);
      const raw = snapToRange(values[key], range);
      const shown = controlValueToDisplay(raw, key, range, caps.deviceName);
      if (slider) slider.value = String(shown);
      if (fill) fill.style.width = `${normalizedPosition(shown, displayRange) * 100}%`;
      if (valueNode) valueNode.textContent = formatValue(shown, display.units, display.decimals);
      if (valueInput) valueInput.value = editableNumber(shown, displayRange);
    }
    // The chips + the floating button re-derive from the applied reference.
    for (const key of controls) {
      const chip = stack.querySelector<HTMLElement>(`.oc-card[data-control="${key}"] .oc-chip-status`);
      const btn = stack.querySelector<HTMLButtonElement>(`.oc-card[data-control="${key}"] .oc-chip-apply`);
      if (!chip || !btn) continue;
      const rawDriver = currentState[key as keyof DeviceState];
      const driver = hiddenNegativeControls.has(key) && key === 'gpuVoltOffsetV'
        && typeof rawDriver === 'number' && rawDriver < 0 && !(key in applied) ? 0 : rawDriver;
      const st = chipState(key, values, applied, driver, true);
      chip.hidden = st !== 'applied';
      if (st === 'applied') {
        chip.textContent = 'Applied';
        chip.className = 'chip oc-chip-status chip-ok';
      } else {
        chip.textContent = '';
        chip.className = 'chip oc-chip-status';
      }
      btn.hidden = st !== 'dirty';
    }
    updateFloating();
  };

  stack.append(
    ...controls.filter((k) => k !== 'powerLimitW').map(buildCard),
    ...(controls.includes('powerLimitW') ? [buildPlCard()] : []),
    tuningActions,
  );
  contentEl.append(view);
  view.append(tuningHeading, stack);
}

// ---------------------------------------------------------------------------
// Fan tab - the reused fan editor (renderFanEditor via the PageContext
// shim - never re-implemented)
// ---------------------------------------------------------------------------

function renderFan(): void {
  clear(contentEl);
  const view = el('div', { class: 'adv-view fan-view' });
  view.append(el('p', { class: 'adv-view-title', text: 'Fan' }));
  contentEl.append(view);
  const editorHost = el('div');
  view.append(editorHost);
  // The PageContext shim: { store: { get, set } } backed by the panel's own
  // state fetch (the fan editor's ONLY surface - it reads deviceId/caps/
  // state/latestSample and applies through api.applySettings itself).
  const ctx: PageContext = { store };
  renderFanEditor(editorHost, ctx);
}

// ---------------------------------------------------------------------------
// Graphics tab - the four M8 cards (the shared option lists EXPORTED from
// pages/graphics.ts - export, never duplicate)
// ---------------------------------------------------------------------------
async function renderGraphics(): Promise<void> {
  clear(contentEl);
  const s = store.get();
  const deviceId = s.deviceId;
  const deviceKey = selectedDeviceKey(s);
  const generation = panelGeneration;
  const view = el('div', { class: 'adv-view graphics-view' });
  if (deviceId === null) {
    view.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
    contentEl.append(view);
    return;
  }
  contentEl.append(view);
  let state: GraphicsState;
  try {
    state = await api.graphicsGet(deviceId);
  } catch (err) {
    if (!panelIdentityMatches(deviceId, deviceKey, generation)
      || activeTab !== 'graphics' || !view.isConnected || !contentEl.contains(view)) return;
    clear(view);
    view.append(el('p', { class: 'text-error', text: `Graphics settings unavailable: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  if (!panelIdentityMatches(deviceId, deviceKey, generation)
    || activeTab !== 'graphics' || !view.isConnected || !contentEl.contains(view)) return;
  graphicsState = state;
  graphicsStateGeneration = generation;
  graphicsDraft = normalizeGraphicsSettings(state);
  graphicsApplied = {};
  graphicsApplying = false;
  graphicsApplyBtn = null;
  renderGraphicsCards(view);
}

function graphicsSupportedOf(state: GraphicsState, key: string): boolean {
  return isGraphicsControlSupported(state, key);
}

function graphicsOptionsOf(state: GraphicsState, key: string): string[] {
  switch (key) {
    case 'frameGenOverride': return state.supportedOptions.frameGen;
    case 'flipMode': return state.supportedOptions.flipModes;
    case 'lowLatency': return DROPDOWN_OPTIONS.lowLatency;
    default: return [];
  }
}

let graphicsState: GraphicsState | null = null;
let graphicsStateGeneration = -1;
let graphicsDraft: GraphicsSettings = {};
let graphicsApplied: GraphicsSettings = {};
let graphicsApplying = false;
let graphicsApplyBtn: HTMLButtonElement | null = null;

// The Advanced Overlay is a quick per-session control surface. Keep the
// restart-sensitive Shared GPU/NPU Memory Override and the battery/platform
// Endurance Gaming controls on the full Graphics page, where their eligibility
// and restart behavior can be explained without making the compact overlay
// imply that they are available on every adapter.
const GRAPHICS_CONTROLS = ['frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency'];

function renderGraphicsCards(view: HTMLElement): void {
  const state = graphicsState;
  if (!state) return;

  const updateFloating = (): void => {
    if (!graphicsApplyBtn) return;
    if (graphicsApplying) { graphicsApplyBtn.hidden = false; return; }
    graphicsApplyBtn.hidden = !computeGraphicsDirty(graphicsDraft, state, graphicsApplied);
  };

  const refreshChip = (key: string): void => {
    const card = view.querySelector<HTMLElement>(`.graphics-card[data-control="${key}"]`);
    if (!card) return;
    const chip = card.querySelector<HTMLElement>('.oc-chip-status');
    const btn = card.querySelector<HTMLButtonElement>('.oc-chip-apply');
    if (!chip || !btn) return;
    const st = chipState(key, graphicsDraft as Record<string, unknown>, graphicsApplied as Record<string, unknown>, state.values[key as keyof GraphicsState['values']], graphicsSupportedOf(state, key));
    chip.hidden = st !== 'applied';
    if (st === 'applied') {
      chip.textContent = 'Applied';
      chip.className = 'chip oc-chip-status chip-ok';
    } else {
      chip.textContent = '';
      chip.className = 'chip oc-chip-status';
    }
    btn.hidden = st !== 'dirty';
  };

  const buildDropdownCard = (key: string): HTMLElement => {
    const supported = graphicsSupportedOf(state, key);
    if (!supported) {
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: key } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const options = graphicsOptionsOf(state, key);
    if (options.length === 0) {
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: key } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const current = (graphicsDraft as Record<string, unknown>)[key] as string;
    const select = el('select', {
      class: 'graphics-select',
      dataset: { graphicsSelect: key },
      onchange: (ev: Event) => {
        (graphicsDraft as Record<string, unknown>)[key] = (ev.target as HTMLSelectElement).value;
        refreshChip(key);
        updateFloating();
      },
    }, options.map((o) => el('option', {
      value: o,
      text: DROPDOWN_LABELS[key]?.[o] ?? o,
      selected: o === current,
    })));
    const chipApplyBtn = el('button', {
      class: 'chip chip-btn oc-chip-apply',
      hidden: true,
      text: 'Apply',
      onClick: () => {
        if (graphicsApplying) return;
        void applyGraphics(key);
      },
    });
    const card = el('section', { class: 'card graphics-card', dataset: { control: key } }, [
      // M23 (user): the chips (Applied / Apply) sit TOP-RIGHT of each card
      // - the old actions row dragged out the card height.
      el('div', { class: 'graphics-card-head' }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('span', { class: 'oc-meta-spacer' }),
        el('span', { class: 'chip oc-chip-status', hidden: true }),
        chipApplyBtn,
      ]),
      el('div', { class: 'graphics-control' }, [select]),
    ]);
    refreshChip(key);
    return card;
  };

  const buildFrameLimitCard = (): HTMLElement => {
    const supported = graphicsSupportedOf(state, 'frameLimit');
    if (!supported) {
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: 'frameLimit' } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES.frameLimit }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const range = frameLimitRange(state);
    const fl = graphicsDraft.frameLimit ?? { enabled: false, value: range.default };
    const toggle = el('select', {
      class: 'graphics-select graphics-toggle',
      dataset: { graphicsToggle: 'frameLimit' },
      onchange: (ev: Event) => {
        const on = (ev.target as HTMLSelectElement).value === 'on';
        graphicsDraft.frameLimit = { enabled: on, value: on ? clampFrameLimitValue(fl.value, range) : fl.value };
        const row = view.querySelector<HTMLElement>('.graphics-fps-slider-row');
        if (row) row.hidden = !on;
        refreshChip('frameLimit');
        updateFloating();
      },
    }, [
      el('option', { value: 'off', text: 'FPS Limit Off', selected: !fl.enabled }),
      el('option', { value: 'on', text: 'FPS Limit On', selected: fl.enabled }),
    ]);
    const slider = el('input', {
      type: 'range',
      class: 'graphics-slider',
      min: range.min,
      max: range.max,
      step: range.step,
      value: clampFrameLimitValue(fl.value, range),
      oninput: (ev: Event) => {
        const v = clampFrameLimitValue(Number((ev.target as HTMLInputElement).value), range);
        graphicsDraft.frameLimit = { enabled: true, value: v };
        const valueNode = view.querySelector<HTMLElement>('.graphics-fps-value');
        if (valueNode) valueNode.textContent = `${v} FPS`;
        refreshChip('frameLimit');
        updateFloating();
      },
    });
    const valueNode = el('span', { class: 'graphics-fps-value', text: `${clampFrameLimitValue(fl.value, range)} FPS` });
    const sliderRow = el('div', { class: 'graphics-fps-slider-row', hidden: !fl.enabled }, [slider, valueNode]);
    const frameLimitApplyBtn = el('button', {
      class: 'chip chip-btn oc-chip-apply',
      hidden: true,
      text: 'Apply',
      onClick: () => {
        if (graphicsApplying) return;
        void applyGraphics('frameLimit');
      },
    });
    const card = el('section', { class: 'card graphics-card', dataset: { control: 'frameLimit' } }, [
      // M23 (user): the chips (Applied / Apply) sit TOP-RIGHT of the card.
      el('div', { class: 'graphics-card-head' }, [
        el('h2', { class: 'card-title', text: CARD_TITLES.frameLimit }),
        el('span', { class: 'oc-meta-spacer' }),
        el('span', { class: 'chip oc-chip-status', hidden: true }),
        frameLimitApplyBtn,
      ]),
      el('div', { class: 'graphics-fps-row' }, [
        el('div', { class: 'graphics-control' }, [toggle]),
        sliderRow,
      ]),
    ]);
    refreshChip('frameLimit');
    return card;
  };

  graphicsApplyBtn = el('button', { class: 'btn btn-primary adv-floating-apply', text: 'Apply', hidden: true });
  graphicsApplyBtn.addEventListener('click', () => {
    if (graphicsApplying) return;
    void applyGraphics();
  });
  const graphicsResetBtn = el('button', {
    class: 'btn btn-ghost btn-sm',
    text: 'Reset to default',
    onClick: () => {
      graphicsApplied = {};
      for (const key of ['frameGenOverride', 'flipMode', 'lowLatency']) {
        const options = graphicsOptionsOf(state, key);
        const documentedDefault = GRAPHICS_RESET_DEFAULTS[key];
        const defaultValue = documentedDefault && options.includes(documentedDefault) ? documentedDefault : options[0];
        if (defaultValue) {
          (graphicsDraft as Record<string, unknown>)[key] = defaultValue;
          const select = view.querySelector<HTMLSelectElement>('select[data-graphics-select="' + key + '"]');
          if (select) select.value = defaultValue;
        }
      }
      const range = frameLimitRange(state);
      graphicsDraft.frameLimit = { enabled: false, value: range.default };
      const toggle = view.querySelector<HTMLSelectElement>('select[data-graphics-toggle="frameLimit"]');
      if (toggle) toggle.value = 'off';
      const slider = view.querySelector<HTMLInputElement>('.graphics-fps-slider-row input[type="range"]');
      if (slider) slider.value = String(range.default);
      const value = view.querySelector<HTMLElement>('.graphics-fps-value');
      if (value) value.textContent = String(range.default) + ' FPS';
      const row = view.querySelector<HTMLElement>('.graphics-fps-slider-row');
      if (row) row.hidden = true;
      for (const key of GRAPHICS_CONTROLS) refreshChip(key);
      updateFloating();
    },
  });
  const graphicsActions = el('div', { class: 'graphics-general-actions tuning-general-actions' }, [graphicsApplyBtn, graphicsResetBtn]);

  const applyGraphics = async (only?: string): Promise<void> => {
    const live = store.get();
    const deviceId = live.deviceId;
    const deviceKey = selectedDeviceKey(live);
    const generation = panelGeneration;
    if (deviceId === null || !graphicsState) return;
    const payload = only !== undefined
      ? (isGraphicsControlDirtyVsApplied(only, graphicsDraft, graphicsState, graphicsApplied)
        ? { [only]: (graphicsDraft as Record<string, unknown>)[only] } as unknown as GraphicsSettings
        : {})
      : buildGraphicsSettings(graphicsDraft, graphicsState, graphicsApplied);
    if (!validateGraphicsSettings(payload)) {
      toast('error', 'Apply aborted', 'The graphics payload failed validation - this is a bug.');
      return;
    }
    if (Object.keys(payload).length === 0) {
      updateFloating();
      return;
    }
    // The DEDICATED graphics path - NO OC waiver anywhere.
    if (live.workerApply && !live.elevated && panelIdentityMatches(deviceId, deviceKey, generation)) {
      toast('info', 'Administrator approval needed', 'Administrator approval is needed to apply GPU settings.');
    }
    graphicsApplying = true;
    if (graphicsApplyBtn) {
      graphicsApplyBtn.disabled = true;
      graphicsApplyBtn.textContent = 'Applying…';
    }
    try {
      const out = await api.graphicsApply(deviceId, payload);
      if (!panelIdentityMatches(deviceId, deviceKey, generation)) return;
      if (out.graphicsState) graphicsState = out.graphicsState;
      for (const [key, per] of Object.entries(out.perControl)) {
        if (per.ok) {
          (graphicsApplied as Record<string, unknown>)[key] = (payload as Record<string, unknown>)[key];
          toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        } else {
          toast('error', `${CONTROL_LABELS[key] ?? key} failed`, applyFailureText(per, key));
        }
      }
      for (const key of GRAPHICS_CONTROLS) refreshChip(key);
      updateFloating();
    } catch (err) {
      if (panelIdentityMatches(deviceId, deviceKey, generation)) {
        toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (panelIdentityMatches(deviceId, deviceKey, generation)) {
        graphicsApplying = false;
        if (graphicsApplyBtn) {
          graphicsApplyBtn.disabled = false;
          graphicsApplyBtn.textContent = 'Apply';
        }
        updateFloating();
      }
    }
  };

  view.append(
    el('div', { class: 'card-stack graphics-stack' }, [
      buildDropdownCard('frameGenOverride'),
      buildDropdownCard('flipMode'),
      buildFrameLimitCard(),
      buildDropdownCard('lowLatency'),
      graphicsActions,
    ]),
  );
  updateFloating();
}

// ---------------------------------------------------------------------------
// Boot
void boot();

