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
import type { PageContext } from './router.ts';
import type { Capabilities, DeviceState, GraphicsSettings, GraphicsState, TelemetrySample } from './types.ts';
import { snapToRange, normalizedPosition, formatValue } from './pure/slider.ts';
import {
  buildScalarSettings,
  validateSettingsPayload,
  isScalarDirtyVsApplied,
  computeDirtyVsApplied,
  cardSliderRange,
} from './pure/settings.ts';
import { applyFailureText, CONTROL_LABELS } from './pure/errors.ts';
import { resolveBootDevice } from './pure/device.ts';
import { chipState } from './pure/chip.ts';
import { renderFanEditor, updateFanReadout } from './pages/fan-editor.ts';
import {
  CARD_TITLES,
  DROPDOWN_LABELS,
  DROPDOWN_OPTIONS,
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

// ---------------------------------------------------------------------------
// The panel store + boot state
// ---------------------------------------------------------------------------

const store = new Store();
let activeTab: 'tuning' | 'fan' | 'graphics' = 'tuning';

const contentEl = document.getElementById('adv-content') as HTMLElement;
const deviceEl = document.getElementById('adv-device') as HTMLElement;
const clockEl = document.getElementById('adv-readout-clock') as HTMLElement;
const tempEl = document.getElementById('adv-readout-temp') as HTMLElement;
const fanEl = document.getElementById('adv-readout-fan') as HTMLElement;
const powerEl = document.getElementById('adv-readout-power') as HTMLElement;
const closeBtn = document.getElementById('adv-close') as HTMLButtonElement;

// M23 (user): NO shortcut info inside the panel - the settings push's
// only former consumer (the hotkey hint) is gone, so the panel does NOT
// subscribe to 'advanced-overlay:settings' (the main side still applies
// the geometry/visibility; the panel needs no pushed state).
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
api.onTelemetrySample((sample) => {
  const live = store.get();
  if (sample.deviceId !== undefined && sample.deviceId !== live.deviceId) return;
  const selected = live.devices.find((device) => device.id === live.deviceId);
  if (sample.deviceKey && selected?.deviceKey && sample.deviceKey !== selected.deviceKey) return;
  store.set({ latestSample: sample });
  renderReadout(sample);
  if (activeTab === 'fan') {
    updateFanReadout(contentEl, { store });
  }
});

// The post-apply device read-back push (the tray/profile apply path).
// M24 (fix): the panel's own apply already handles state updates via
// renderTuningInPlace - a full re-render from the push causes a race
// (the push arrives before applied[] is set, so the rebuilt chips show
// 'dirty' instead of 'applied'). Just update the store; the next tab
// switch or explicit render picks up the fresh state.
api.onStateUpdated((payload) => {
  if (payload && payload.state) {
    store.set({ state: payload.state });
  }
});

// M24 (Part B): pushed POST-APPLY GRAPHICS read-backs (the twin of
// onStateUpdated for the graphics surface). M24 (fix): same race as the
// tuning handler - the panel's own graphics apply already handles state
// updates; just update the store.
api.onGraphicsStateUpdated((payload) => {
  if (payload && payload.deviceId === store.get().deviceId) {
    graphicsState = payload.graphicsState;
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
}

// ---------------------------------------------------------------------------
// Boot: deviceGet -> getCapabilities -> getCurrentSettings -> render
// ---------------------------------------------------------------------------

async function resolveAdvancedOverlayDeviceId(): Promise<number | null> {
  let persisted: { deviceId?: number | null; deviceKey?: string | null } | null = null;
  try {
    persisted = await api.deviceGet();
  } catch {
    return null;
  }
  const fallback = typeof persisted?.deviceId === 'number' && persisted.deviceId >= 0
    ? persisted.deviceId
    : null;
  try {
    const devices = await api.listDevices();
    return resolveBootDevice(devices, fallback, persisted?.deviceKey ?? null);
  } catch {
    return fallback;
  }
}

async function boot(): Promise<void> {
  const deviceId = await resolveAdvancedOverlayDeviceId();
  store.set({ deviceId });

  if (deviceId === null) {
    deviceEl.textContent = 'No GPU available.';
    renderTab();
    return;
  }

  let caps: Capabilities | null = null;
  let state: DeviceState | null = null;
  try {
    caps = await api.getCapabilities(deviceId);
    state = await api.getCurrentSettings(deviceId);
  } catch {
    caps = null;
    state = null;
  }
  store.set({ caps, state });
  deviceEl.textContent = caps?.deviceName || 'Unknown GPU';
  renderTab();
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
// ---------------------------------------------------------------------------

// The scalar cards (the panel's set - PL IS included: editable like the
// main Tuning page; the PL1/PL2 sysman readout rides its card's meta line).
// Gated by caps.controls like the main Tuning page.
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

  if (s.deviceId === null) {
    view.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
    contentEl.append(view);
    return;
  }
  if (!caps || !state) {
    view.append(el('p', { class: 'page-subtitle', text: 'Loading device capabilities…' }));
    contentEl.append(view);
    return;
  }
  if (caps.overclockingSupported === false) {
    view.append(el('p', { class: 'page-subtitle', text: 'Tuning is not supported on this GPU. Telemetry remains available.' }));
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
  // range only exists for a supported control, so the range check IS the
  // support check and the canonical-keyed cards render).
  const controls = SCALAR_CONTROLS.filter((key) => cardSliderRange(caps, key) !== undefined);
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
    const valueNode = el('span', { class: 'oc-value', text: formatValue(values[key], range.units) });
    const rangeNode = el('span', { class: 'oc-range', text: `${range.min} – ${range.max} ${range.units}` });
    const fill = el('div', { class: 'oc-track-fill' });
    fill.style.width = `${normalizedPosition(values[key], range) * 100}%`;
    const slider = el('input', {
      type: 'range',
      min: String(range.min),
      max: String(range.max),
      step: String(range.step),
      value: String(values[key]),
      oninput: (ev: Event) => {
        const raw = Number((ev.target as HTMLInputElement).value);
        const v = snapToRange(raw, range);
        hiddenNegativeControls.delete(key);
        values[key] = v;
        valueNode.textContent = formatValue(v, range.units);
        fill.style.width = `${normalizedPosition(v, range) * 100}%`;
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

  const applyScalar = async (only?: string): Promise<void> => {
    const live = store.get();
    const deviceId = live.deviceId;
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
    if (live.workerApply && !live.elevated) {
      toast('info', 'Administrator approval needed', 'Administrator approval is needed to apply GPU settings.');
    }
    const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, caps.deviceName || 'this GPU', live.caps?.overclockingSupported !== false);
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
      // M24 (fix): set the applied reference BEFORE store.set - the M24
      // sync push fires onStateUpdated → renderTuning() which clears +
      // rebuilds the DOM; if applied is not yet set, the rebuilt chips
      // show 'dirty' instead of 'applied'. Setting applied first ensures
      // the re-render picks up the correct chip state.
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
      toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      updateFloating();
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
      if (slider) slider.value = String(snapToRange(values[key], range));
      if (fill) fill.style.width = `${normalizedPosition(values[key], range) * 100}%`;
      if (valueNode) valueNode.textContent = formatValue(values[key], range.units);
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
    el('p', { class: 'adv-view-title', text: 'Tuning' }),
    ...controls.filter((k) => k !== 'powerLimitW').map(buildCard),
    buildPlCard(),
    tuningApplyBtn as HTMLElement,
  );
  contentEl.append(view);
  view.append(stack);
  updateFloating();
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

let graphicsState: GraphicsState | null = null;
let graphicsDraft: GraphicsSettings = {};
let graphicsApplied: GraphicsSettings = {};
let graphicsApplying = false;
let graphicsApplyBtn: HTMLButtonElement | null = null;

const GRAPHICS_CONTROLS = ['frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency'];

async function renderGraphics(): Promise<void> {
  clear(contentEl);
  const s = store.get();
  const view = el('div', { class: 'adv-view graphics-view' });
  if (s.deviceId === null) {
    view.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
    contentEl.append(view);
    return;
  }
  view.append(el('p', { class: 'page-subtitle', text: 'Loading graphics capabilities…' }));
  contentEl.append(view);
  let state: GraphicsState;
  try {
    state = await api.graphicsGet(s.deviceId);
  } catch (err) {
    clear(view);
    view.append(el('p', { class: 'text-error', text: `Graphics settings unavailable: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  graphicsState = state;
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

function renderGraphicsCards(view: HTMLElement): void {
  const state = graphicsState;
  if (!state) return;
  clear(view);

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

  const applyGraphics = async (only?: string): Promise<void> => {
    const live = store.get();
    const deviceId = live.deviceId;
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
    if (live.workerApply && !live.elevated) {
      toast('info', 'Administrator approval needed', 'Administrator approval is needed to apply GPU settings.');
    }
    graphicsApplying = true;
    if (graphicsApplyBtn) {
      graphicsApplyBtn.disabled = true;
      graphicsApplyBtn.textContent = 'Applying…';
    }
    try {
      const out = await api.graphicsApply(deviceId, payload);
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
      toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
    } finally {
      graphicsApplying = false;
      if (graphicsApplyBtn) {
        graphicsApplyBtn.disabled = false;
        graphicsApplyBtn.textContent = 'Apply';
      }
      updateFloating();
    }
  };

  view.append(
    el('div', { class: 'card-stack graphics-stack' }, [
      buildDropdownCard('frameGenOverride'),
      buildDropdownCard('flipMode'),
      buildFrameLimitCard(),
      buildDropdownCard('lowLatency'),
      graphicsApplyBtn as HTMLElement,
    ]),
  );
  updateFloating();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void boot();
