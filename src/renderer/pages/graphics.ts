// Arc Power - M8 the Graphics tab (the IGS-mirror page). Standard cards are
// rendered in the planned order: XeSS Frame Generation Override, Frame
// Synchronization, FPS Limit, Low Latency. Integrated adapters may prepend
// their mobile-only Endurance Gaming and shared-memory cards. The page mirrors
// Intel Graphics Software (IGS):
// every setting is a real IGCL 3D feature (ctlGetSupported3DCapabilities /
// ctlGetSet3DFeature - live-verified settable on this driver by the M8
// checkpoint-1 probe).
//
// M10b: the page gains a second view mode - "Graphics | Display" (the M9
// Monitoring-view pattern: the segmented pill + the view container + the
// module view state). The Display view mirrors the IGS "Display" tab: the
// per-display selector, GENERAL (scaling + VRR), COLOR (quantization + the
// driver-backed color controls) and INFORMATION (the read-only rows). Each
// writable surface is capability-gated and verified by native read-back;
// unavailable controls remain visibly read-only instead of pretending to
// apply.
//
// The DEDICATED graphics + display apply paths (plan-review S1): the page
// NEVER rides the OC apply-routing machinery - the 'graphics:apply' +
// 'display:apply' IPC channels + the 'graphics-apply'/'display-apply'
// worker ops. NO OC waiver anywhere in the flow; the elevation toast
// pattern (workerApply && !elevated) is kept - the worker still spawns
// elevated for the packaged app.
//
// The card/chip/Apply pattern mirrors the Tuning page: the dirty vs the
// LOADED DRIVER state -> the chip + the floating Apply button appear.
// M9: the shared chip state machine (pure/chip.ts) drives the per-card
// status + the NEW per-card Apply button: 'none' (pristine - the hidden
// attribute, invisible via the CSS [hidden] fix), green "Applied" while
// equal to the last applied, 'dirty' (the per-card Apply button - the old
// "Unapplied" warn chip is GONE). The supported-features caps gate the
// cards ('Not supported on this GPU.' - no control); the driver's
// SupportedTypes gate the dropdown options
// (Speed Sync only when the driver exposes them - the honest probe record;
// the M9 On + Boost change makes the Low Latency list FULL off/on/on-boost
// on every driver - the card gate stays).
//
// The no-Intel guard renders FIRST (deviceId null -> 'No GPU available.') -
// graphics:get / display:get are NEVER called with a null deviceId
// (assertValidDeviceId would throw).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { applyFailureText, CONTROL_LABELS, errorMessage } from '../pure/errors.ts';
import { buildDeviceSelect } from '../components/device-select.ts';
import { chipState } from '../pure/chip.ts';
import {
  FRAME_GEN_OPTIONS,
  FLIP_MODE_OPTIONS,
  LOW_LATENCY_OPTIONS,
  ENDURANCE_GAMING_OPTIONS,
  ENDURANCE_GAMING_MODE_OPTIONS,
  frameLimitRange,
  clampFrameLimitValue,
  normalizeGraphicsSettings,
  validateGraphicsSettings,
  computeGraphicsDirty,
  buildGraphicsSettings,
  isGraphicsControlSupported,
  isGraphicsControlDirtyVsApplied,
} from '../pure/graphics.ts';
import {
  isDisplayControlSupported,
  displayDriverValue,
  normalizeDisplaySettings,
  validateDisplaySettings,
  snapDisplayColorValue,
  rawScalingForView,
  effectiveScalingModeOf,
  scalingViewOf as displayScalingViewOf,
  scalingMethodViewOf as displayScalingMethodViewOf,
  scalingMethodOptionsForView,
  type DisplayColorRange,
  isDisplayControlDirtyVsApplied as isDisplayControlDirtyVsAppliedPure,
} from '../pure/display.ts';
import type { DisplayCapability, DisplaySettings, DisplayState, FrameGenOverride, FlipMode, GraphicsSettings, GraphicsState, LowLatency } from '../types.ts';

export const APPLY_BTN_TEXT = 'Apply';
export const APPLY_BTN_BUSY_TEXT = 'Applying…';
// M2C-C first-apply elevation explanation (the Tuning pattern): shown right
// before the UAC prompt (a short toast - the prompt itself is the OS's,
// this explains why).
export const ELEVATION_TOAST_TEXT = 'Administrator approval is needed to apply GPU settings.';
export const ELEVATION_CANCELED_TEXT = 'Apply requires administrator approval.';

// The driver notes (one per card).
// M23: EXPORTED - the ADVANCED overlay's Graphics tab imports them (export,
// never duplicate - the option lists/labels/titles/notes are the single
// source both surfaces render from).
export const CARD_NOTES: Record<string, string> = {
  enduranceGaming: 'Battery-aware game tuning for supported Intel integrated graphics. Auto lets the driver manage the mode while on battery.',
  enduranceGamingMode: 'Choose the battery target used by Endurance Gaming: 60 FPS, 40 FPS, or 30 FPS.',
  sharedMemoryOverride: 'Changes how much system memory the integrated GPU/NPU may share. Restart Windows after applying.',
  frameGenOverride: "Sets the driver's XeSS frame-generation override for games that use XeSS Frame Generation (the game may need a restart for the change to apply).",
  flipMode: 'The driver\'s frame-synchronization mode (VSync / Smooth Sync / Speed Sync). Smart VSync is not exposed by the driver interface.',
  frameLimit: 'A driver-level frame-rate cap. The limiter works independently of Arc Power.',
  lowLatency: 'The driver\'s XeLL-based low-latency mode.',
};

// Display-view notes for the driver-backed IGS-style controls.
const DISPLAY_SCALING_NOTE = 'Changes may briefly flash the display.';
const DISPLAY_SCALING_METHOD_NOTE = 'Custom mode exposes horizontal and vertical scaling.';
const DISPLAY_GLOBAL_VRR_NOTE = 'Choose when variable refresh rate is used.';
const DISPLAY_VRR_NOTE = 'Choose whether variable refresh rate is enabled.';
const DISPLAY_SLIDERS_NOTE = 'IGS-style display color controls; Apply verifies the driver read-back.';
const DISPLAY_WIRE_READONLY_NOTE = 'The driver did not report writable color-format data.';
const DISPLAY_NO_DISPLAYS_NOTE = 'No display settings are available on this GPU.';

export const CARD_TITLES: Record<string, string> = {
  enduranceGaming: 'Endurance Gaming',
  enduranceGamingMode: 'Endurance Gaming Preset',
  sharedMemoryOverride: 'Shared GPU/NPU Memory Override',
  frameGenOverride: 'XeSS Frame Generation Override',
  flipMode: 'Frame Synchronization',
  frameLimit: 'FPS Limit',
  lowLatency: 'Low Latency Mode',
};

export const DROPDOWN_LABELS: Record<string, Record<string, string>> = {
  enduranceGaming: { off: 'Off', on: 'On', auto: 'Auto' },
  enduranceGamingMode: { performance: 'Performance · 60 FPS', balanced: 'Balanced · 40 FPS', battery: 'Battery · 30 FPS' },
  frameGenOverride: { 'app-choice': 'Application Default', '2x': '2x Frame Generation', '3x': '3x Frame Generation', '4x': '4x Frame Generation' },
  flipMode: { 'application-default': 'Application Choice', 'vsync-on': 'Enable VSync', 'vsync-off': 'Disable VSync', 'smooth-sync': 'Smooth Sync', 'speed-frame': 'Speed Sync' },
  lowLatency: { off: 'Off', on: 'On', 'on-boost': 'On + Boost' },
};

// M10b: the Display dropdown label maps (the canonical driver strings ->
// the IGS-style labels).
const QUANTIZATION_LABELS: Record<string, string> = {
  default: 'Default',
  limited: 'Limited',
  full: 'Full',
};
const SCALING_MODE_LABELS: Record<string, string> = {
  identity: 'Identity',
  centered: 'Centered',
  stretched: 'Stretched',
  'aspect-ratio-centered-max': 'Aspect Ratio Centered Max',
  custom: 'Custom',
};
const IGS_SCALING_MODE_OPTIONS = ['gpu-scaling', 'display-scaling', 'retro-scaling'];
const IGS_SCALING_MODE_LABELS: Record<string, string> = {
  'gpu-scaling': 'GPU Scaling',
  'display-scaling': 'Display Scaling',
  'retro-scaling': 'Retro Scaling',
};
const IGS_SCALING_METHOD_LABELS: Record<string, string> = {
  'maintain-display-scaling': 'Maintain Display Scaling',
  custom: 'Custom',
  centered: 'Centered',
  stretched: 'Stretched',
  'aspect-ratio-centered-max': 'Aspect Ratio Centered Max',
  integer: 'Integer Scaling',
  'nearest-neighbour': 'Nearest Neighbour',
};
const GLOBAL_VRR_LABELS: Record<string, string> = {
  fullscreen: 'Fullscreen',
  'fullscreen-windowed': 'Fullscreen & Windowed',
  disabled: 'Disabled',
};
const VARIABLE_REFRESH_RATE_LABELS: Record<string, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
};
const IGS_WIRE_FORMATS = ['RGB', 'YCbCr444'];
const IGS_WIRE_FORMAT_LABELS: Record<string, string> = {
  RGB: 'RGB',
  YCbCr444: 'YCbCr 4:4:4',
};
const RETRO_SCALING_LABELS: Record<string, string> = {
  integer: 'Integer Scaling',
  'nearest-neighbour': 'Nearest Neighbour',
};
const ARC_SYNC_LABELS: Record<string, string> = {
  recommended: 'Recommended',
  excellent: 'Excellent',
  good: 'Good',
  compatible: 'Compatible',
  off: 'Off',
  vesa: 'VESA',
  custom: 'Custom',
};

// Documented IGS defaults. A driver may omit one of these values from its
// capability list; callers then retain the historical first-supported
// fallback instead of manufacturing an unsupported reset payload.
export const GRAPHICS_RESET_DEFAULTS: Record<string, string> = {
  enduranceGaming: 'off',
  enduranceGamingMode: 'performance',
  frameGenOverride: 'app-choice',
  flipMode: 'application-default',
  lowLatency: 'off',
};
export const DROPDOWN_OPTIONS: Record<string, string[]> = {
  enduranceGaming: ENDURANCE_GAMING_OPTIONS,
  enduranceGamingMode: ENDURANCE_GAMING_MODE_OPTIONS,
  frameGenOverride: FRAME_GEN_OPTIONS,
  flipMode: FLIP_MODE_OPTIONS,
  lowLatency: LOW_LATENCY_OPTIONS,
};

const DISPLAY_RESET_DEFAULTS: Record<string, string> = {
  globalVrrMode: 'fullscreen',
  quantizationRange: 'default',
};

function resetOption(key: string, options: string[], defaults: Record<string, string>): string | null {
  if (options.length === 0) return null;
  const documented = defaults[key];
  return documented && options.includes(documented) ? documented : options[0];
}

function displayWireFormatDefault(display: DisplayState['displays'][number]): NonNullable<DisplaySettings['wireFormat']> | null {
  const models = display.supportedOptions.wireFormats;
  const depths = display.supportedOptions.bpcDepths;
  if (models.length === 0 || depths.length === 0) return null;
  return {
    model: (models.includes('RGB') ? 'RGB' : models[0]) as NonNullable<DisplaySettings['wireFormat']>['model'],
    depth: depths.includes(8) ? 8 : depths[0],
  };
}

// Per-render mutable state (hoisted so onUpdate can refresh in place -
// only one page renders at a time, the Tuning pattern).
let graphicsState: GraphicsState | null = null;
let draft: GraphicsSettings = {};
let applied: GraphicsSettings = {};
// M10b: the Display view's per-render state (loaded via display:get at
// render; the apply envelope carries the fresh read-back).
let displayState: DisplayState | null = null;
let selectedDisplayId: number | null = null;
let selectedDisplayKey: string | null = null;
let displayDraft: DisplaySettings = {};
let displayApplied: DisplaySettings = {};
let displayScalingViewDraft = 'display-scaling';
let displayScalingMethodDraft = 'maintain-display-scaling';
let applying = false;
let queuedDisplayApply: { ctx: PageContext; only: string } | null = null;
let applyBtn: HTMLButtonElement | null = null;
let displayApplyBtn: HTMLButtonElement | null = null;
let displayResetBtn: HTMLButtonElement | null = null;
const chipNodes = new Map<string, HTMLElement>();
// M9: the per-card Apply button (the chip state machine) - visible ONLY
// while that card is dirty; clicking it applies THAT card only.
const chipApplyNodes = new Map<string, HTMLButtonElement>();
const valueNodes = new Map<string, HTMLElement>();
const sliderNodes = new Map<string, HTMLInputElement>();
// M17c: the FPS-limiter slider-ROW (slider + value text) - the whole row
// hides when the limiter is OFF (the "30 FPS" text bug: the value text
// used to stay visible while only the slider hid).
const sliderRowNodes = new Map<string, HTMLElement>();
const toggleNodes = new Map<string, HTMLSelectElement>();
const selectNodes = new Map<string, HTMLSelectElement>();
const GRAPHICS_REFRESH_KEYS = ['enduranceGaming', 'enduranceGamingMode', 'sharedMemoryOverride', 'frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency'];
let viewContainer: HTMLElement | null = null;
let displayPickerHost: HTMLElement | null = null;
let currentCtx: PageContext | null = null;
let renderGeneration = 0;

// M24 (Part B): subscribe ONCE to the graphics-state push (the ADVANCED
// overlay panel's graphics apply + any future external graphics write). On a
// matching deviceId: update the module state + re-sync draft per the B5
// rule (applied controls keep the user's position; never-applied controls
// take the pushed value unconditionally), then re-render the card list from
// the module state (no re-fetch).
api.onGraphicsStateUpdated((payload) => {
  if (!currentCtx) return;
  const s = currentCtx.store.get();
  if (s.deviceId === null || payload.deviceId !== s.deviceId) return;
  graphicsState = payload.graphicsState;
  const pushedDraft = normalizeGraphicsSettings(payload.graphicsState);
  for (const key of GRAPHICS_REFRESH_KEYS) {
    if (key in applied) continue;
    if (key in pushedDraft) (draft as Record<string, unknown>)[key] = (pushedDraft as Record<string, unknown>)[key];
  }
  if (viewContainer && viewContainer.isConnected) {
    renderCards(viewContainer, currentCtx);
  }
});

// M10b: the Graphics page's sub-view - 'settings' = the M8 3D-feature
// cards, 'display' = the Display view. Module-level (persists across
// re-renders - a navigation re-entry must not drop the active view, the
// Monitoring-view pattern).
let graphicsView: 'settings' | 'display' = 'settings';

function resetPageState() {
  graphicsState = null;
  draft = {};
  applied = {};
  displayState = null;
  selectedDisplayId = null;
  selectedDisplayKey = null;
  displayDraft = {};
  displayApplied = {};
  displayScalingViewDraft = 'display-scaling';
  displayScalingMethodDraft = 'maintain-display-scaling';
  applying = false;
  applyBtn = null;
  displayApplyBtn = null;
  displayResetBtn = null;
  chipNodes.clear();
  chipApplyNodes.clear();
  valueNodes.clear();
  sliderNodes.clear();
  sliderRowNodes.clear();
  toggleNodes.clear();
  selectNodes.clear();
  viewContainer = null;
  displayPickerHost = null;
  currentCtx = null;
}

/** M10b: the currently selected display of the loaded state (null when
 *  nothing loaded or the display list is empty - the honest degrade). */
function selectedDisplay(): DisplayState['displays'][number] | null {
  if (!displayState) return null;
  return displayState.displays.find((d) => d.displayKey === selectedDisplayKey)
    ?? displayState.displays.find((d) => d.id === selectedDisplayId)
    ?? displayState.displays[0] ?? null;
}

function scalingViewOf(display: DisplayState['displays'][number] | null): string {
  return displayScalingViewOf(display);
}

function scalingMethodViewOf(display: DisplayState['displays'][number] | null): string {
  return displayScalingMethodViewOf(display);
}

function customScalingOf(display: DisplayState['displays'][number]): NonNullable<DisplaySettings['scalingCustom']> {
  const details = display.scalingDetails;
  const isCustom = effectiveScalingModeOf(display) === 'custom';
  return {
    // Identity/centered read-backs commonly return zero because the custom
    // fields are inactive. IGS treats Custom as 100/100 until that mode is
    // selected, so do not turn an inactive 0/0 into the visible default.
    x: isCustom && Number.isFinite(details?.customX) && details!.customX > 0 ? Math.max(0, Math.min(100, details!.customX)) : 100,
    y: isCustom && Number.isFinite(details?.customY) && details!.customY > 0 ? Math.max(0, Math.min(100, details!.customY)) : 100,
    // A new Custom transition is an IGS-style physical modeset. Never carry
    // an old/disabled read-back flag into the next user-initiated apply.
    hardwareModeSet: true,
  };
}

function sameCustomScaling(a: DisplaySettings['scalingCustom'] | null | undefined, b: DisplaySettings['scalingCustom'] | null | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.hardwareModeSet === b.hardwareModeSet;
}

/** Keep the chip baseline in the same user-facing vocabulary as the two
 * scaling selectors. `normalizeDisplaySettings` intentionally retains raw
 * IGCL scalingMode values for payload construction, so the UI baseline must
 * be overlaid separately. */
function setDisplayAppliedScalingBaseline(): void {
  displayApplied = { ...displayDraft };
  (displayApplied as Record<string, unknown>).scalingMode = displayScalingViewDraft;
  (displayApplied as Record<string, unknown>).displayScalingMethod = displayScalingMethodDraft;
}

/** M9: the shared chip state machine (pure/chip.ts) drives the per-card
 *  status + the per-card Apply button: 'none' (pristine or unsupported -
 *  the hidden attribute, invisible via the CSS [hidden] fix), 'applied'
 *  (the green chip), 'dirty' (the Apply button - the old "Unapplied" warn
 *  chip is GONE). The card gate (isGraphicsControlSupported) is the
 *  machine's supported flag - an unsupported control never renders a
 *  control, so its state would be 'none' anyway. */
function refreshChip(key: string) {
  const chip = chipNodes.get(key);
  if (!chip) return;
  const state = chipState(
    key,
    draft as Record<string, unknown>,
    applied as Record<string, unknown>,
    graphicsState?.values[key as keyof GraphicsState['values']],
    isGraphicsControlSupported(graphicsState, key),
  );
  chip.hidden = state !== 'applied';
  if (state === 'applied') {
    chip.textContent = 'Applied';
    chip.className = 'chip oc-chip-status chip-ok';
  } else {
    // M9 review finding 3: leaving 'applied' must reset the className -
    // the hidden ('none') + button ('dirty') states never carry a stale
    // chip-ok (green) class.
    chip.textContent = '';
    chip.className = 'chip oc-chip-status';
  }
  const btn = chipApplyNodes.get(key);
  if (btn) btn.hidden = state !== 'dirty';
}

/** Display-view chip state uses the driver value and its capability gate;
 *  controls without a complete writable contract remain read-only. */
function refreshDisplayChip(key: string) {
  const chip = chipNodes.get(key);
  if (!chip) return;
  const display = selectedDisplay();
  const viewKey = key === 'scalingMode' ? displayScalingViewDraft
    : key === 'displayScalingMethod' ? displayScalingMethodDraft
      : (displayDraft as Record<string, unknown>)[key];
  const appliedKey = key === 'scalingMode' ? (displayApplied as Record<string, unknown>)[key]
    : key === 'displayScalingMethod' ? (displayApplied as Record<string, unknown>)[key]
      : (displayApplied as Record<string, unknown>)[key];
  const driverValue = key === 'scalingMode' ? scalingViewOf(display)
    : key === 'displayScalingMethod' ? scalingMethodViewOf(display)
      : displayDriverValue(display, key);
  const customDirty = key === 'displayScalingMethod' && displayScalingMethodDraft === 'custom'
    && !sameCustomScaling(displayDraft.scalingCustom, customScalingOf(display!));
  const state = customDirty ? 'dirty' : chipState(key, { [key]: viewKey }, { [key]: appliedKey }, driverValue, key === 'scalingMode' || key === 'displayScalingMethod'
    ? isDisplayControlSupported(display, 'scalingMode')
    : isDisplayControlSupported(display, key));
  chip.hidden = state !== 'applied';
  if (state === 'applied') {
    chip.textContent = 'Applied';
    chip.className = 'chip oc-chip-status chip-ok';
  } else {
    chip.textContent = '';
    chip.className = 'chip oc-chip-status';
  }
  const btn = chipApplyNodes.get(key);
  if (btn) btn.hidden = state !== 'dirty';
  updateDisplayFloating();
}

function updateFloating() {
  if (!applyBtn) return;
  if (applying) return;
  applyBtn.hidden = !computeGraphicsDirty(draft, graphicsState, applied);
}

function refreshAll() {
  for (const key of GRAPHICS_REFRESH_KEYS) refreshChip(key);
  updateFloating();
}

// Color correction and wire-format editing stay implemented in the native
// layer, but the Display UI intentionally exposes only Quantization Range
// until those driver paths are revalidated on every adapter. Keeping the
// hidden keys out of this list prevents a global Apply from sending controls
// the user cannot see or edit.
const DISPLAY_APPLY_KEYS = ['scalingMode', 'displayScalingMethod', 'globalVrrMode', 'variableRefreshRate', 'quantizationRange'];
const DISPLAY_COLOR_KEYS = ['hue', 'saturation', 'brightness', 'contrast'];

function displayHasDirtyDraft(display: DisplayState['displays'][number] | null): boolean {
  if (!display) return false;
  return DISPLAY_APPLY_KEYS.some((key) => {
    if (key === 'scalingMode' || key === 'displayScalingMethod') return displayPayloadForControl(key, display) !== null;
    return isDisplayControlDirtyVsAppliedPure(key, displayDraft, display, displayApplied);
  });
}

function updateDisplayFloating(): void {
  if (!displayApplyBtn) return;
  displayApplyBtn.hidden = applying ? false : !displayHasDirtyDraft(selectedDisplay());
  displayApplyBtn.disabled = applying;
  displayApplyBtn.textContent = applying ? APPLY_BTN_BUSY_TEXT : APPLY_BTN_TEXT;
}

function resetDisplayDraft(display: DisplayState['displays'][number]): void {
  displayDraft = normalizeDisplaySettings(display);
  if (isDisplayControlSupported(display, 'scalingMode')) {
    displayScalingViewDraft = 'display-scaling';
    displayDraft.scalingMode = rawScalingForView(display, displayScalingViewDraft);
    delete displayDraft.scalingCustom;
  }
  if (isDisplayControlSupported(display, 'displayScalingMethod')) {
    displayScalingMethodDraft = 'maintain-display-scaling';
    displayDraft.displayScalingMethod = 'maintain-display-scaling';
  }
  if (isDisplayControlSupported(display, 'scalingMethod')) {
    displayDraft.scalingMethod = { enabled: false, method: display.scalingMethod?.value?.method ?? 'integer' };
  }
  for (const key of ['hue', 'saturation', 'brightness', 'contrast'] as DisplayColorKey[]) {
    const range = display.supportedOptions.colorRanges?.[key];
    if (range?.default !== undefined) (displayDraft as Record<string, unknown>)[key] = range.default;
  }
  if (display.supportedOptions.globalVrrModes.length > 0) {
    const defaultValue = resetOption('globalVrrMode', display.supportedOptions.globalVrrModes, DISPLAY_RESET_DEFAULTS);
    if (defaultValue !== null) displayDraft.globalVrrMode = defaultValue as DisplaySettings['globalVrrMode'];
  }
  if (isDisplayControlSupported(display, 'variableRefreshRate')) {
    displayDraft.variableRefreshRate = display.variableRefreshRate?.value ?? true;
  }
  if (display.supportedOptions.quantizationRanges.length > 0) {
    const defaultValue = resetOption('quantizationRange', display.supportedOptions.quantizationRanges, DISPLAY_RESET_DEFAULTS);
    if (defaultValue !== null) displayDraft.quantizationRange = defaultValue as DisplaySettings['quantizationRange'];
  }
  const defaultWireFormat = displayWireFormatDefault(display);
  if (defaultWireFormat) displayDraft.wireFormat = defaultWireFormat;
  displayApplied = {};
}

export const graphicsPage: Page = {
  id: 'graphics',

  async render(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    clear(container);
    resetPageState();
    const generation = ++renderGeneration;
    currentCtx = ctx;
    // The deviceId-null guard runs FIRST (plan-review S3): on the no-Intel
    // path deviceId is null and graphics:get/display:get must NEVER be
    // called with it (assertValidDeviceId throws) - the honest answer is
    // the Tuning-style 'No GPU available.' guard.
    if (s.deviceId === null) {
      container.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
      return;
    }

    // M10b: the "Graphics | Display" view pill (the M9 Monitoring-view
    // pattern) + the view container; the ACTIVE view renders below.
    viewContainer = el('div', { class: 'graphics-view' });
    displayPickerHost = el('div', { class: 'display-picker-host' });
    const deviceSelect = buildDeviceSelect(ctx.store, (id) => void ctx.selectDevice?.(id));
    const title = el('div', { class: 'page-title-row' }, [
      el('h1', { class: 'page-title', text: graphicsView === 'display' ? 'Display' : 'Graphics' }),
      ...(deviceSelect ? [deviceSelect] : []),
    ]);
    const viewToggle = el('div', { class: 'graphics-view-toggle-row' }, [
      el('div', { class: 'oc-mode-toggle graphics-view-toggle', role: 'group', 'aria-label': 'Graphics view' }, [
        el('button', {
          class: `oc-mode-btn graphics-view-btn${graphicsView === 'settings' ? ' active' : ''}`,
          dataset: { view: 'settings' },
          text: 'Graphics',
          onClick: () => setGraphicsView('settings'),
        }),
        el('button', {
          class: `oc-mode-btn graphics-view-btn${graphicsView === 'display' ? ' active' : ''}`,
          dataset: { view: 'display' },
          text: 'Display',
          onClick: () => setGraphicsView('display'),
        }),
      ]),
    ]);
    container.append(
      title,
      el('p', {
        class: 'page-subtitle',
        text: graphicsView === 'display'
          ? 'Display settings and capabilities reported by the graphics driver.'
          : 'Driver-level graphics settings (the same state the Intel Graphics Software app manages). Changes apply on demand - nothing is applied until you press Apply.',
      }),
      el('div', { class: 'graphics-view-toolbar' }, [viewToggle, displayPickerHost]),
      viewContainer,
    );
    viewContainer.append(el('p', { class: 'page-subtitle', text: 'Loading graphics capabilities…' }));

    // M10b: the view switch re-renders ONLY the sub-view container - every
    // (re)build re-registers the node maps (chip/select/slider/...) so the
    // apply handlers + the chip refreshes always write into the LIVE view
    // and never into the detached nodes a clear(viewContainer) orphans (the
    // M9 S2 re-registration contract).
    const renderGraphicsView = (): void => {
      if (!viewContainer) return;
      // Each sub-view load gets a new generation. A slow Display read must
      // not commit after the user has switched back to Graphics.
      const subViewGeneration = ++renderGeneration;
      if (displayPickerHost) clear(displayPickerHost);
      if (graphicsView === 'display') {
        void renderDisplayView(viewContainer, ctx, subViewGeneration);
        return;
      }
      void renderSettingsView(viewContainer, ctx, subViewGeneration);
    };
    const setGraphicsView = (v: 'settings' | 'display'): void => {
      if (graphicsView === v) return;
      graphicsView = v;
      renderGraphicsView();
      const heading = title.querySelector<HTMLElement>('.page-title');
      if (heading) heading.textContent = graphicsView === 'display' ? 'Display' : 'Graphics';
      const subtitle = container.querySelector<HTMLElement>('.page-subtitle');
      if (subtitle) subtitle.textContent = graphicsView === 'display'
        ? 'Display settings and capabilities reported by the graphics driver.'
        : 'Driver-level graphics settings (the same state the Intel Graphics Software app manages). Changes apply on demand - nothing is applied until you press Apply.';
      viewToggle.querySelectorAll<HTMLButtonElement>('.graphics-view-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === graphicsView);
      });
    };
    renderGraphicsView();
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // The graphics + display states are page-owned (loaded via the
    // graphicsGet/displayGet IPC at render; the apply envelopes carry the
    // fresh read-backs). A device switch / featureset swap re-renders the
    // whole page via the router. Nothing to refresh from the store's OC
    // slots - the guard below keeps a stale render from crashing on a
    // mid-switch null deviceId.
    const s = ctx.store.get();
    if (s.deviceId === null && (graphicsState !== null || displayState !== null)) {
      graphicsPage.render(container, ctx);
    }
  },
};

// ---------------------------------------------------------------------------
// The Graphics (settings) view - the M8 cards
// ---------------------------------------------------------------------------

/** M8: the settings view load + cards (the old render() body, extracted so
 *  the view switch can rebuild it). The state is page-owned: every rebuild
 *  re-fetches via graphicsGet (fresh) and re-registers the node maps. */
async function renderSettingsView(view: HTMLElement, ctx: PageContext, generation: number): Promise<void> {
  const s = ctx.store.get();
  const deviceId = s.deviceId;
  if (deviceId === null) return; // the render guard already handled this
  const selected = s.devices.find((device) => device.id === deviceId);
  const deviceKey = selected?.deviceKey ?? s.caps?.deviceKey ?? null;
  const isCurrentRender = (): boolean => {
    const live = ctx.store.get();
    const liveSelected = live.devices.find((device) => device.id === live.deviceId);
    return renderGeneration === generation
      && currentCtx === ctx
      && view.isConnected
      && live.deviceId === deviceId
      && (liveSelected?.deviceKey ?? live.caps?.deviceKey ?? null) === deviceKey;
  };
  clear(view);
  view.append(el('p', { class: 'page-subtitle', text: 'Loading graphics capabilities…' }));
  let state: GraphicsState;
  try {
    state = await api.graphicsGet(deviceId);
  } catch (err) {
    if (!isCurrentRender()) return;
    clear(view);
    view.append(el('p', { class: 'text-error', text: `Graphics settings unavailable: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  if (!isCurrentRender()) return;
  graphicsState = state;
  draft = normalizeGraphicsSettings(state);
  renderCards(view, ctx);
}

function supportedOf(state: GraphicsState, key: string): boolean {
  switch (key) {
    case 'enduranceGaming': return state.supported.enduranceGaming === true;
    case 'enduranceGamingMode': return state.supported.enduranceGaming === true
      && (state.supportedOptions.enduranceGamingModes?.length ?? 0) > 0;
    case 'sharedMemoryOverride': {
      const range = state.sharedMemoryRange;
      return state.supported.sharedMemoryOverride === true
        && !!range
        && Number.isInteger(range.min) && Number.isInteger(range.max)
        && range.min >= 13 && range.max >= range.min && range.max <= 100;
    }
    case 'frameGenOverride': return state.supported.frameGen;
    case 'flipMode': return state.supported.flipModes;
    case 'frameLimit': return state.supported.frameLimit;
    case 'lowLatency': return state.supported.lowLatency;
    default: return false;
  }
}

// M9 (the On + Boost fix): the Low Latency dropdown returns the FULL option
// list (off/on/on-boost) on every driver - what gated the option before was
// the DRIVER caps hiding the boost bit on this driver (the M8 caps 0x3
// report off/on only). The CARD gate stays (supportedOf + the empty-options
// guard + isGraphicsControlSupported): an unsupported driver still shows
// the honest no-control card, never a dead control. The backend's set path
// still refuses on-boost on a driver that does not expose the bit (the
// honest refusal through the apply-result machinery - never raw hex).
function optionsOf(state: GraphicsState, key: string): string[] {
  switch (key) {
    case 'enduranceGaming': return state.supportedOptions.enduranceGaming ?? [];
    case 'enduranceGamingMode': return state.supportedOptions.enduranceGamingModes ?? [];
    case 'frameGenOverride': return state.supportedOptions.frameGen;
    case 'flipMode': return state.supportedOptions.flipModes;
    case 'lowLatency': return LOW_LATENCY_OPTIONS;
    default: return [];
  }
}

function sharedMemoryRange(state: GraphicsState): { min: number; max: number; step: number; default: number } {
  const range = state.sharedMemoryRange;
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max)
    && range.max >= range.min && Number.isFinite(range.step) && range.step > 0) {
    return range;
  }
  return { min: 13, max: 100, step: 1, default: 57 };
}

function renderCards(view: HTMLElement, ctx: PageContext) {
  clear(view);
  const state = graphicsState;
  if (!state) return;

  // The floating Apply exists ONLY when at least one feature is supported -
  // an all-false session (the honest degrade) has nothing to apply (the
  // null driver values would otherwise count as dirty and show the button).
  const anySupported = state.supported.frameGen || state.supported.flipModes
    || state.supported.frameLimit || state.supported.lowLatency
    || supportedOf(state, 'enduranceGaming') || supportedOf(state, 'sharedMemoryOverride');
  applyBtn = anySupported ? el('button', { class: 'btn btn-primary floating-apply', text: APPLY_BTN_TEXT }) : null;
  applyBtn?.addEventListener('click', () => {
    if (applying) return;
    void apply(ctx);
  });

  const resetAllBtn = el('button', {
    class: 'btn btn-ghost btn-sm',
    text: 'Reset to default',
    onClick: () => {
      for (const key of ['enduranceGaming', 'enduranceGamingMode', 'frameGenOverride', 'flipMode', 'lowLatency']) {
        const options = optionsOf(state, key);
        const defaultValue = resetOption(key, options, GRAPHICS_RESET_DEFAULTS);
        if (defaultValue !== null) {
          (draft as Record<string, unknown>)[key] = defaultValue;
          const select = selectNodes.get(key);
          if (select) select.value = defaultValue;
        }
      }
      const range = frameLimitRange(state);
      draft.frameLimit = { enabled: false, value: range.default };
      const toggle = toggleNodes.get('frameLimit');
      if (toggle) toggle.value = 'off';
      const slider = sliderNodes.get('frameLimit');
      if (slider) slider.value = String(range.default);
      const value = valueNodes.get('frameLimit');
      if (value) value.textContent = String(range.default) + ' FPS';
      const row = sliderRowNodes.get('frameLimit');
      if (row) row.hidden = true;
      const memoryRange = sharedMemoryRange(state);
      draft.sharedMemoryOverride = { enabled: false, percentage: memoryRange.default };
      const memoryToggle = toggleNodes.get('sharedMemoryOverride');
      if (memoryToggle) memoryToggle.value = 'off';
      const memorySlider = sliderNodes.get('sharedMemoryOverride');
      if (memorySlider) memorySlider.value = String(memoryRange.default);
      const memoryValue = valueNodes.get('sharedMemoryOverride');
      if (memoryValue) memoryValue.textContent = `${memoryRange.default}% of system memory`;
      const memoryRow = sliderRowNodes.get('sharedMemoryOverride');
      if (memoryRow) memoryRow.hidden = true;
      refreshAll();
    },
  });

  const buildDropdownCard = (key: string): HTMLElement => {
    const supported = supportedOf(state, key);
    const optionalMobileControl = key === 'enduranceGaming' || key === 'enduranceGamingMode';
    if (!supported && optionalMobileControl) return el('span', { hidden: true });
    if (!supported) {
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: key } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const options = optionsOf(state, key);
    if (options.length === 0) {
      if (optionalMobileControl) return el('span', { hidden: true });
      // Supported but the driver exposes no option bits - honest no-control
      // state (offering un-appliable values would lie).
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: key } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const current = (draft as Record<string, unknown>)[key] as string;
    const select = el('select', {
      class: 'graphics-select',
      dataset: { graphicsSelect: key },
      onchange: (e: Event) => {
        (draft as Record<string, unknown>)[key] = (e.target as HTMLSelectElement).value;
        refreshChip(key);
        updateFloating();
      },
    }, options.map((o) => el('option', {
      value: o,
      text: DROPDOWN_LABELS[key]?.[o] ?? o,
      selected: o === current,
    })));
    selectNodes.set(key, select);
    const card = el('section', { class: 'card graphics-card', dataset: { control: key } }, [
      el('div', { class: 'graphics-card-heading' }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('div', { class: 'graphics-control graphics-inline-control' }, [select]),
      ]),
      el('p', { class: 'card-note', text: CARD_NOTES[key] }),
      el('div', { class: 'graphics-card-actions' }, [
        el('span', { class: 'chip oc-chip-status', hidden: true }),
        // M9: the per-card Apply button (the chip state machine) - a
        // small-chip button visible ONLY while this card is dirty; it
        // applies THAT card only (the same graphics:apply channel with the
        // single key).
        el('button', {
          class: 'chip chip-btn oc-chip-apply',
          hidden: true,
          text: 'Apply',
          onClick: () => {
            if (applying) return;
            void apply(ctx, key);
          },
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Reset to default',
          onClick: () => {
            const defaultValue = resetOption(key, options, GRAPHICS_RESET_DEFAULTS);
            if (defaultValue === null) return;
            (draft as Record<string, unknown>)[key] = defaultValue;
            const sel = selectNodes.get(key);
            if (sel) sel.value = defaultValue;
            refreshChip(key);
            updateFloating();
          },
        }),
      ]),
    ]);
    chipNodes.set(key, card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
    chipApplyNodes.set(key, card.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
    refreshChip(key);
    return card;
  };

  const buildFrameLimitCard = (): HTMLElement => {
    const supported = state.supported.frameLimit;
    if (!supported) {
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: 'frameLimit' } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES.frameLimit }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const range = frameLimitRange(state);
    const fl = draft.frameLimit ?? { enabled: false, value: range.default };
    // M17c (user request): the ON/OFF checkbox becomes a DROPDOWN with
    // Off / On options - Off = { enabled: false, value }, On =
    // { enabled: true, value } + the slider-row appears. The
    // draft.frameLimit { enabled, value } shape is UNCHANGED (the
    // apply/verify/state paths untouched).
    const toggle = el('select', {
      class: 'graphics-select graphics-toggle graphics-fps-select',
      dataset: { graphicsToggle: 'frameLimit' },
      onchange: (e: Event) => {
        const on = (e.target as HTMLSelectElement).value === 'on';
        draft.frameLimit = { enabled: on, value: on ? clampFrameLimitValue(fl.value, range) : fl.value };
        const row = sliderRowNodes.get('frameLimit');
        if (row) row.hidden = !on;
        refreshChip('frameLimit');
        updateFloating();
      },
    }, [
      el('option', { value: 'off', text: 'FPS Limit Off', selected: !fl.enabled }),
      el('option', { value: 'on', text: 'FPS Limit On', selected: fl.enabled }),
    ]);
    toggleNodes.set('frameLimit', toggle);
    const slider = el('input', {
      type: 'range',
      class: 'graphics-slider',
      min: range.min,
      max: range.max,
      step: range.step,
      value: clampFrameLimitValue(fl.value, range),
      oninput: (e: Event) => {
        const raw = Number((e.target as HTMLInputElement).value);
        const v = clampFrameLimitValue(raw, range);
        draft.frameLimit = { enabled: true, value: v };
        const valueNode = valueNodes.get('frameLimit');
        if (valueNode) valueNode.textContent = `${v} FPS`;
        refreshChip('frameLimit');
        updateFloating();
      },
    });
    sliderNodes.set('frameLimit', slider);
    const valueNode = el('span', { class: 'graphics-fps-value', text: `${clampFrameLimitValue(fl.value, range)} FPS` });
    valueNodes.set('frameLimit', valueNode);
    // The whole slider-row (slider + the '30 FPS' value text) hides when
    // the limiter is OFF - the reported bug was the value text staying
    // visible while only the slider hid.
    const sliderRow = el('div', { class: 'graphics-fps-slider-row', hidden: !fl.enabled }, [slider, valueNode]);
    sliderRowNodes.set('frameLimit', sliderRow);
    const card = el('section', { class: 'card graphics-card', dataset: { control: 'frameLimit' } }, [
      el('div', { class: 'graphics-card-heading' }, [
        el('h2', { class: 'card-title', text: CARD_TITLES.frameLimit }),
        el('div', { class: 'graphics-control graphics-inline-control' }, [toggle]),
      ]),
      el('p', { class: 'card-note', text: CARD_NOTES.frameLimit }),
      el('div', { class: 'graphics-fps-row' }, [
        sliderRow,
      ]),
      el('div', { class: 'graphics-card-actions' }, [
        el('span', { class: 'chip oc-chip-status', hidden: true }),
        // M9: the per-card Apply button (the chip state machine) - same
        // single-key apply as the dropdown cards.
        el('button', {
          class: 'chip chip-btn oc-chip-apply',
          hidden: true,
          text: 'Apply',
          onClick: () => {
            if (applying) return;
            void apply(ctx, 'frameLimit');
          },
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Reset to default',
          onClick: () => {
            // M17c: the reset mirrors the Off state - the select flips to
            // Off and the WHOLE slider-row hides (the value text included).
            draft.frameLimit = { enabled: false, value: range.default };
            const t = toggleNodes.get('frameLimit');
            if (t) t.value = 'off';
            const row = sliderRowNodes.get('frameLimit');
            if (row) row.hidden = true;
            const sl = sliderNodes.get('frameLimit');
            if (sl) {
              sl.value = String(range.default);
            }
            const vn = valueNodes.get('frameLimit');
            if (vn) vn.textContent = `${range.default} FPS`;
            refreshChip('frameLimit');
            updateFloating();
          },
        }),
      ]),
    ]);
    chipNodes.set('frameLimit', card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
    chipApplyNodes.set('frameLimit', card.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
    refreshChip('frameLimit');
    return card;
  };

  const buildSharedMemoryCard = (): HTMLElement => {
    const range = sharedMemoryRange(state);
    const current = draft.sharedMemoryOverride ?? { enabled: false, percentage: range.default };
    const clamp = (value: number): number => {
      const snapped = range.step > 0 ? Math.round(value / range.step) * range.step : value;
      return Math.min(range.max, Math.max(range.min, snapped));
    };
    const toggle = el('select', {
      class: 'graphics-select graphics-toggle',
      dataset: { graphicsToggle: 'sharedMemoryOverride' },
      onchange: (e: Event) => {
        const enabled = (e.target as HTMLSelectElement).value === 'on';
        draft.sharedMemoryOverride = { enabled, percentage: clamp(draft.sharedMemoryOverride?.percentage ?? range.default) };
        const row = sliderRowNodes.get('sharedMemoryOverride');
        if (row) row.hidden = !enabled;
        refreshChip('sharedMemoryOverride');
        updateFloating();
      },
    }, [
      el('option', { value: 'off', text: 'Off', selected: !current.enabled }),
      el('option', { value: 'on', text: 'On', selected: current.enabled }),
    ]);
    toggleNodes.set('sharedMemoryOverride', toggle);
    const slider = el('input', {
      type: 'range',
      class: 'graphics-slider',
      min: range.min,
      max: range.max,
      step: range.step,
      value: clamp(current.percentage),
      oninput: (e: Event) => {
        const percentage = clamp(Number((e.target as HTMLInputElement).value));
        draft.sharedMemoryOverride = { enabled: true, percentage };
        const value = valueNodes.get('sharedMemoryOverride');
        if (value) value.textContent = `${percentage}% of system memory`;
        const t = toggleNodes.get('sharedMemoryOverride');
        if (t) t.value = 'on';
        refreshChip('sharedMemoryOverride');
        updateFloating();
      },
    });
    sliderNodes.set('sharedMemoryOverride', slider);
    const value = el('span', { class: 'graphics-fps-value graphics-memory-value', text: `${clamp(current.percentage)}% of system memory` });
    valueNodes.set('sharedMemoryOverride', value);
    const sliderRow = el('div', { class: 'graphics-fps-slider-row', hidden: !current.enabled }, [slider, value]);
    sliderRowNodes.set('sharedMemoryOverride', sliderRow);
    const card = el('section', { class: 'card graphics-card', dataset: { control: 'sharedMemoryOverride' } }, [
      el('div', { class: 'graphics-card-heading' }, [
        el('h2', { class: 'card-title', text: CARD_TITLES.sharedMemoryOverride }),
        el('div', { class: 'graphics-control graphics-inline-control' }, [toggle]),
      ]),
      el('p', { class: 'card-note', text: CARD_NOTES.sharedMemoryOverride }),
      el('div', { class: 'graphics-fps-row' }, [sliderRow]),
      el('div', { class: 'graphics-card-actions' }, [
        el('span', { class: 'chip oc-chip-status', hidden: true }),
        el('button', {
          class: 'chip chip-btn oc-chip-apply',
          hidden: true,
          text: 'Apply',
          onClick: () => {
            if (applying) return;
            void apply(ctx, 'sharedMemoryOverride');
          },
        }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Reset to default',
          onClick: () => {
            draft.sharedMemoryOverride = { enabled: false, percentage: range.default };
            toggle.value = 'off';
            slider.value = String(range.default);
            value.textContent = `${range.default}% of system memory`;
            sliderRow.hidden = true;
            refreshChip('sharedMemoryOverride');
            updateFloating();
          },
        }),
      ]),
    ]);
    chipNodes.set('sharedMemoryOverride', card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
    chipApplyNodes.set('sharedMemoryOverride', card.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
    refreshChip('sharedMemoryOverride');
    return card;
  };

  const mobileCards: HTMLElement[] = [];
  // These cards are appended only when the backend proves the selected
  // adapter is an integrated Intel GPU. A discrete mobile Arc adapter never
  // receives these nodes, even if its name contains "Mobile" or ends in M.
  if (supportedOf(state, 'enduranceGaming')) mobileCards.push(buildDropdownCard('enduranceGaming'));
  if (supportedOf(state, 'enduranceGamingMode')) mobileCards.push(buildDropdownCard('enduranceGamingMode'));
  if (supportedOf(state, 'sharedMemoryOverride')) mobileCards.push(buildSharedMemoryCard());

  // The standard cards remain in the established order; the mobile/iGPU-only
  // controls sit together at the top of the list.
  view.append(
    el('div', { class: 'graphics-general-actions' }, [
      ...(applyBtn ? [applyBtn as Node] : []),
      resetAllBtn,
    ]),
    el('div', { class: 'card-stack graphics-stack' }, [
      ...mobileCards,
      buildDropdownCard('frameGenOverride'),
      buildDropdownCard('flipMode'),
      buildFrameLimitCard(),
      buildDropdownCard('lowLatency'),
    ]),
  );
  updateFloating();
}

// ---------------------------------------------------------------------------
// M10b: the Display view (the IGS "Display" tab mirror)
// ---------------------------------------------------------------------------

/** The Display view load + cards. The state is page-owned: every rebuild
 *  re-fetches via display:get (fresh - the per-display state loads at
 *  render) and re-registers the node maps (the S2 contract). The empty
 *  display list (RID_MOCK_DISPLAY_UNSUPPORTED / the multi-device iGPU /
 *  no-Intel) renders the honest no-controls note - never a crash. */
async function renderDisplayView(view: HTMLElement, ctx: PageContext, generation: number): Promise<void> {
  const s = ctx.store.get();
  if (s.deviceId === null) return; // the render guard already handled this
  const selected = s.devices.find((device) => device.id === s.deviceId);
  const deviceKey = selected?.deviceKey ?? s.caps?.deviceKey ?? null;
  const isCurrentRender = (): boolean => {
    const live = ctx.store.get();
    const liveSelected = live.devices.find((device) => device.id === live.deviceId);
    return renderGeneration === generation
      && currentCtx === ctx
      && view.isConnected
      && live.deviceId === s.deviceId
      && (liveSelected?.deviceKey ?? live.caps?.deviceKey ?? null) === deviceKey;
  };
  clear(view);
  view.append(el('p', { class: 'page-subtitle', text: 'Loading display information…' }));
  let state: DisplayState;
  try {
    state = await api.displayGet(s.deviceId);
  } catch (err) {
    if (!isCurrentRender()) return;
    clear(view);
    view.append(el('p', { class: 'text-error', text: `Display settings unavailable: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  if (!isCurrentRender()) return;
  displayState = state;
  // The first display is the default (the IGS left-pane analogue); the
  // draft + the applied reference reset for the newly selected display.
  selectedDisplayId = state.displays[0]?.id ?? null;
  selectedDisplayKey = state.displays[0]?.displayKey ?? null;
  displayDraft = normalizeDisplaySettings(selectedDisplay());
  displayScalingViewDraft = scalingViewOf(selectedDisplay());
  displayScalingMethodDraft = scalingMethodViewOf(selectedDisplay());
  // Establish a clean baseline from the fresh driver read-back. Without this
  // the first render treated every exposed value as an unapplied edit when a
  // driver temporarily omitted a value (notably global VRR).
  setDisplayAppliedScalingBaseline();
  renderDisplayCards(view, ctx);
}

/** One dropdown control row of the Display view (the M9 chip machine + the
 *  per-card Apply button; the S2 contract registers the nodes). An
 *  optionless control (the driver exposes no values) renders the honest
 *  no-control state - offering un-appliable values would lie. */
function buildDisplayDropdownRow(
  ctx: PageContext,
  key: string,
  title: string,
  note: string,
  options: string[],
  labels: Record<string, string>,
): HTMLElement {
  if (key === 'scalingMode') return buildDisplayScalingModeRow(ctx);
  if (key === 'variableRefreshRate') return buildVariableRefreshRateRow(ctx);
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, key);
  if (!supported || options.length === 0) {
    const capability = key === 'globalVrrMode' ? display?.globalVrrMode : key === 'vrrMode' ? display?.vrrMode : undefined;
    const allowed = key === 'globalVrrMode' && options.length > 0
      ? `IGS options: ${options.map((option) => labels[option] ?? option).join(', ')}. `
      : '';
    return el('div', { class: 'display-control display-control-readonly', dataset: { control: key } }, [
      el('h3', { class: 'display-control-title', text: title }),
      el('p', { class: 'card-note', text: `${allowed}${capability?.reason ?? 'Not supported on this GPU.'}` }),
    ]);
  }
  const current = ((displayDraft as Record<string, unknown>)[key] as string | undefined) ?? options[0];
  const select = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: key },
    onchange: (e: Event) => {
      (displayDraft as Record<string, unknown>)[key] = (e.target as HTMLSelectElement).value;
      refreshDisplayChip(key);
    },
  }, options.map((o) => el('option', {
    value: o,
    text: labels[o] ?? o,
    selected: o === current,
  })));
  selectNodes.set(key, select);
  const row = el('div', { class: 'display-control', dataset: { control: key } }, [
    el('div', { class: 'display-control-heading' }, [
      el('h3', { class: 'display-control-title', text: title }),
      el('div', { class: 'graphics-control display-inline-control' }, [select]),
    ]),
    el('p', { class: 'card-note', text: note }),
    el('div', { class: 'graphics-card-actions' }, [
      el('span', { class: 'chip oc-chip-status', hidden: true }),
      // M9: the per-card Apply button (the chip state machine) - a
      // small-chip button visible ONLY while this row is dirty; it applies
      // THAT control only (the same display:apply channel with the single
      // key).
      el('button', {
        class: 'chip chip-btn oc-chip-apply',
        hidden: true,
        text: 'Apply',
        onClick: () => {
          if (applying) return;
          void applyDisplay(ctx, key);
        },
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Reset to default',
        onClick: () => {
          const defaultValue = resetOption(key, options, DISPLAY_RESET_DEFAULTS);
          if (defaultValue === null) return;
          (displayDraft as Record<string, unknown>)[key] = defaultValue;
          const sel = selectNodes.get(key);
          if (sel) sel.value = defaultValue;
          refreshDisplayChip(key);
        },
      }),
    ]),
  ]);
  chipNodes.set(key, row.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
  chipApplyNodes.set(key, row.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
  refreshDisplayChip(key);
  return row;
}

/** IGS presents ordinary, display, and retro scaling as one three-way view.
 * Keep the raw IGCL scaling flags internal and translate the selection into
 * one serialized driver transaction as soon as the selector changes. */
function buildDisplayScalingModeRow(ctx: PageContext): HTMLElement {
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, 'scalingMode');
  if (!supported) {
    return el('div', { class: 'display-control display-control-readonly', dataset: { control: 'scalingMode' } }, [
      el('h3', { class: 'display-control-title', text: 'Scaling Mode' }),
      el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
    ]);
  }
  const select = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: 'scalingMode' },
    onchange: (e: Event) => {
      displayScalingViewDraft = (e.target as HTMLSelectElement).value;
      displayScalingMethodDraft = scalingMethodOptionsForView(display!, displayScalingViewDraft)[0] ?? 'maintain-display-scaling';
      const raw = rawScalingForView(display!, displayScalingViewDraft);
      if (displayScalingViewDraft === 'gpu-scaling') {
        displayDraft.scalingMode = displayScalingMethodDraft as DisplaySettings['scalingMode'];
        displayDraft.displayScalingMethod = displayScalingMethodDraft as DisplaySettings['displayScalingMethod'];
        delete displayDraft.scalingCustom;
        delete displayDraft.scalingMethod;
      } else if (displayScalingViewDraft === 'display-scaling') {
        displayDraft.scalingMode = raw;
        delete displayDraft.scalingCustom;
        delete displayDraft.scalingMethod;
      } else {
        displayDraft.scalingMode = raw;
        delete displayDraft.scalingCustom;
        displayDraft.scalingMethod = {
          enabled: true,
          method: displayScalingMethodDraft as NonNullable<DisplaySettings['scalingMethod']>['method'],
        };
      }
      // The second row is mode-dependent. Rebuild the local card stack so
      // the new IGS method list appears immediately instead of leaving the
      // Display/Retro choices from the previous mode in the DOM.
      if (viewContainer && viewContainer.isConnected) renderDisplayCards(viewContainer, ctx);
      // Intel Graphics Software commits a mode selection immediately. Keep
      // the per-card Apply button as a safe retry/fallback, but do not leave a
      // normal GPU/Display/Retro selection as draft-only state.
      setTimeout(() => requestDisplayApply(ctx, 'scalingMode'), 0);
    },
  }, IGS_SCALING_MODE_OPTIONS.map((option) => el('option', {
    value: option,
    text: IGS_SCALING_MODE_LABELS[option],
    selected: option === displayScalingViewDraft,
  })));
  selectNodes.set('scalingMode', select);
  const row = el('div', { class: 'display-control', dataset: { control: 'scalingMode' } }, [
    el('div', { class: 'display-control-heading' }, [
      el('h3', { class: 'display-control-title', text: 'Scaling Mode' }),
      el('div', { class: 'graphics-control display-inline-control' }, [select]),
    ]),
    el('p', { class: 'card-note', text: DISPLAY_SCALING_NOTE }),
    el('div', { class: 'graphics-card-actions' }, [
      el('span', { class: 'chip oc-chip-status', hidden: true }),
      el('button', { class: 'chip chip-btn oc-chip-apply', hidden: true, text: 'Apply', onClick: () => { if (!applying) void applyDisplay(ctx, 'scalingMode'); } }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', onClick: () => {
        displayScalingViewDraft = 'display-scaling';
        displayDraft.scalingMode = rawScalingForView(display!, displayScalingViewDraft);
        delete displayDraft.scalingCustom;
        if (display.scalingMethod?.value?.enabled === true) {
          displayDraft.scalingMethod = { enabled: false, method: display.scalingMethod.value.method };
        } else {
          delete displayDraft.scalingMethod;
        }
        select.value = displayScalingViewDraft;
        refreshDisplayChip('scalingMode');
      } }),
    ]),
  ]);
  chipNodes.set('scalingMode', row.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
  chipApplyNodes.set('scalingMode', row.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
  refreshDisplayChip('scalingMode');
  return row;
}

/** IGS's second scaling row is the ordinary Display Scaling method. Retro's
 * raw enable/type pair stays an internal compatibility payload. */
function buildDisplayScalingMethodRow(ctx: PageContext): HTMLElement {
  const display = selectedDisplay();
  const view = displayScalingViewDraft;
  const methodOptions = scalingMethodOptionsForView(display, view);
  const supported = display !== null && methodOptions.length > 0
    && (view === 'retro-scaling'
      ? isDisplayControlSupported(display, 'scalingMethod')
      : isDisplayControlSupported(display, 'scalingMode'));
  if (!supported) {
    return el('div', { class: 'display-control display-control-readonly', dataset: { control: 'displayScalingMethod' }, title: DISPLAY_SCALING_METHOD_NOTE }, [
      el('h3', { class: 'display-control-title', text: 'Scaling Method' }),
      el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
    ]);
  }
  const methodSelect = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: 'displayScalingMethod' },
    onchange: (e: Event) => {
      displayScalingMethodDraft = (e.target as HTMLSelectElement).value;
      if (view === 'gpu-scaling') {
        displayDraft.scalingMode = displayScalingMethodDraft as DisplaySettings['scalingMode'];
        delete displayDraft.scalingCustom;
        delete displayDraft.scalingMethod;
      } else if (view === 'retro-scaling') {
        displayDraft.scalingMethod = {
          enabled: true,
          method: displayScalingMethodDraft as NonNullable<DisplaySettings['scalingMethod']>['method'],
        };
      } else {
        displayDraft.displayScalingMethod = displayScalingMethodDraft as DisplaySettings['displayScalingMethod'];
        displayDraft.scalingMode = displayScalingMethodDraft === 'custom' ? 'custom' : 'identity';
        if (displayScalingMethodDraft === 'custom') displayDraft.scalingCustom = customScalingOf(display!);
        else delete displayDraft.scalingCustom;
      }
      customX.hidden = view !== 'display-scaling' || displayScalingMethodDraft !== 'custom';
      customY.hidden = view !== 'display-scaling' || displayScalingMethodDraft !== 'custom';
      refreshDisplayChip('displayScalingMethod');
      // Custom waits for its X/Y values and the explicit Apply button. The
      // remaining IGS methods are immediate driver transitions and should
      // produce the same single modeset/flash as IGS.
      if (!(view === 'display-scaling' && displayScalingMethodDraft === 'custom')) {
        setTimeout(() => requestDisplayApply(ctx, 'displayScalingMethod'), 0);
      }
    },
  }, methodOptions.map((option) => el('option', { value: option, text: IGS_SCALING_METHOD_LABELS[option] ?? option, selected: option === displayScalingMethodDraft })));
  selectNodes.set('displayScalingMethod', methodSelect);
  const custom = customScalingOf(display!);
  const customX = el('input', { class: 'display-number-input', type: 'number', min: 0, max: 100, step: 1, value: custom.x, hidden: view !== 'display-scaling' || displayScalingMethodDraft !== 'custom', 'aria-label': 'Custom horizontal scaling' }) as HTMLInputElement;
  const customY = el('input', { class: 'display-number-input', type: 'number', min: 0, max: 100, step: 1, value: custom.y, hidden: view !== 'display-scaling' || displayScalingMethodDraft !== 'custom', 'aria-label': 'Custom vertical scaling' }) as HTMLInputElement;
  const setCustom = (): void => {
    displayDraft.scalingCustom = { x: Math.max(0, Math.min(100, Number(customX.value))), y: Math.max(0, Math.min(100, Number(customY.value))), hardwareModeSet: true };
    refreshDisplayChip('displayScalingMethod');
  };
  customX.addEventListener('change', setCustom);
  customY.addEventListener('change', setCustom);
  const row = el('div', { class: 'display-control', dataset: { control: 'displayScalingMethod' } }, [
    el('div', { class: 'display-control-heading' }, [
      el('h3', { class: 'display-control-title', text: 'Scaling Method' }),
      el('div', { class: 'graphics-control display-inline-control' }, [methodSelect]),
    ]),
    el('p', { class: 'card-note', text: DISPLAY_SCALING_METHOD_NOTE }),
    el('div', { class: 'graphics-control display-custom-scaling-row' }, [customX, customY]),
    el('div', { class: 'graphics-card-actions' }, [
      el('span', { class: 'chip oc-chip-status', hidden: true }),
      el('button', { class: 'chip chip-btn oc-chip-apply', hidden: true, text: 'Apply', onClick: () => { if (!applying) void applyDisplay(ctx, 'displayScalingMethod'); } }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', onClick: () => {
        displayScalingMethodDraft = methodOptions[0] ?? 'maintain-display-scaling';
        if (view === 'gpu-scaling') {
          displayDraft.scalingMode = displayScalingMethodDraft as DisplaySettings['scalingMode'];
          delete displayDraft.scalingCustom;
          delete displayDraft.scalingMethod;
        } else if (view === 'retro-scaling') {
          displayDraft.scalingMethod = { enabled: true, method: displayScalingMethodDraft as NonNullable<DisplaySettings['scalingMethod']>['method'] };
        } else {
          displayDraft.displayScalingMethod = displayScalingMethodDraft as DisplaySettings['displayScalingMethod'];
          displayDraft.scalingMode = displayScalingMethodDraft === 'custom' ? 'custom' : 'identity';
          delete displayDraft.scalingCustom;
        }
        methodSelect.value = displayScalingMethodDraft;
        customX.hidden = view !== 'display-scaling' || displayScalingMethodDraft !== 'custom';
        customY.hidden = view !== 'display-scaling' || displayScalingMethodDraft !== 'custom';
        refreshDisplayChip('displayScalingMethod');
      } }),
    ]),
  ]);
  chipNodes.set('displayScalingMethod', row.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
  chipApplyNodes.set('displayScalingMethod', row.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
  refreshDisplayChip('displayScalingMethod');
  return row;
}

/** The wire-format row holds the two IGS-style selects (Color Format + Color
 *  Depth) that compose the single wireFormat patch key { model, depth }.
 *  Capability data decides whether the row is writable or read-only. */
function buildWireFormatRow(ctx: PageContext): HTMLElement {
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, 'wireFormat');
  if (!supported) {
    return el('div', { class: 'display-control display-control-readonly', dataset: { control: 'wireFormat' } }, [
      el('h3', { class: 'display-control-title', text: 'Color Format' }),
      el('p', { class: 'card-note', text: DISPLAY_WIRE_READONLY_NOTE }),
      el('div', { class: 'display-wire-format-readonly' }, [
        el('div', { class: 'display-info-row' }, [
          el('span', { class: 'display-info-label', text: 'Color Format' }),
          el('span', { class: 'display-info-value', text: display?.colorFormat ?? '-' }),
        ]),
        el('div', { class: 'display-info-row' }, [
          el('span', { class: 'display-info-label', text: 'Color Depth' }),
          el('span', { class: 'display-info-value', text: display?.colorDepth !== null && display?.colorDepth !== undefined ? `${display.colorDepth} bpc` : '-' }),
        ]),
      ]),
    ]);
  }
  const wf: NonNullable<DisplaySettings['wireFormat']> = displayDraft.wireFormat ?? displayWireFormatDefault(display!)!;
  const modelSelect = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: 'colorFormat' },
    onchange: (e: Event) => {
      displayDraft.wireFormat = { model: (e.target as HTMLSelectElement).value as NonNullable<DisplaySettings['wireFormat']>['model'], depth: wf.depth };
      refreshDisplayChip('wireFormat');
    },
  }, display!.supportedOptions.wireFormats.filter((o) => IGS_WIRE_FORMATS.includes(o)).map((o) => el('option', {
    value: o,
    text: IGS_WIRE_FORMAT_LABELS[o] ?? o,
    selected: o === wf.model,
  })));
  const depthSelect = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: 'colorDepth' },
    onchange: (e: Event) => {
      displayDraft.wireFormat = { model: wf.model, depth: Number((e.target as HTMLSelectElement).value) };
      refreshDisplayChip('wireFormat');
    },
  }, display!.supportedOptions.bpcDepths.map((d) => el('option', {
    value: String(d),
    text: `${d} bpc`,
    selected: d === wf.depth,
  })));
  selectNodes.set('wireFormat', modelSelect);
  selectNodes.set('wireFormatDepth', depthSelect);
  const row = el('div', { class: 'display-control', dataset: { control: 'wireFormat' } }, [
    el('h3', { class: 'display-control-title', text: 'Color Format' }),
    el('p', { class: 'card-note', text: 'Choose the display output color format.' }),
    el('div', { class: 'graphics-control display-wire-format-row' }, [
      el('label', { class: 'display-wire-format-field' }, [
        el('span', { class: 'display-wire-format-field-label', text: 'Color Format' }),
        modelSelect,
      ]),
      el('label', { class: 'display-wire-format-field' }, [
        el('span', { class: 'display-wire-format-field-label', text: 'Color Depth' }),
        depthSelect,
      ]),
    ]),
    el('div', { class: 'graphics-card-actions' }, [
      el('span', { class: 'chip oc-chip-status', hidden: true }),
      el('button', {
        class: 'chip chip-btn oc-chip-apply',
        hidden: true,
        text: 'Apply',
        onClick: () => {
          if (applying) return;
          void applyDisplay(ctx, 'wireFormat');
        },
      }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        text: 'Reset to default',
        onClick: () => {
          const defaultWireFormat = displayWireFormatDefault(display!);
          if (!defaultWireFormat) return;
          displayDraft.wireFormat = defaultWireFormat;
          const m = selectNodes.get('wireFormat');
          if (m) m.value = defaultWireFormat.model;
          const d = selectNodes.get('wireFormatDepth');
          if (d) d.value = String(defaultWireFormat.depth);
          refreshDisplayChip('wireFormat');
        },
      }),
    ]),
  ]);
  chipNodes.set('wireFormat', row.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
  chipApplyNodes.set('wireFormat', row.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
  refreshDisplayChip('wireFormat');
  return row;
}

function displayCapabilityText<T>(capability: DisplayCapability<T> | undefined, fallback = 'Not available'): string {
  if (!capability) return fallback;
  if (capability.value === null || capability.value === undefined) {
    return capability.supported === false ? 'Not supported' : fallback;
  }
  if (typeof capability.value === 'boolean') return capability.value ? 'Enabled' : 'Disabled';
  return String(capability.value);
}

type DisplayColorKey = 'hue' | 'saturation' | 'brightness' | 'contrast';

// IGCL exposes native correction factors while IGS presents the same controls
// as a 0-100 editor with 50 as the neutral/default midpoint. Keep drafts in
// native units for the driver payload, but make the visible controls match
// IGS and avoid showing values such as saturation=1 or brightness=0.
function colorUiValue(key: DisplayColorKey, native: number, range: DisplayColorRange): number {
  if (key === 'hue') return native;
  const neutral = Number.isFinite(range.default) ? Number(range.default) : (range.min + range.max) / 2;
  const ui = native <= neutral
    ? 50 * (native - range.min) / Math.max(0.0001, neutral - range.min)
    : 50 + 50 * (native - neutral) / Math.max(0.0001, range.max - neutral);
  return Math.max(0, Math.min(100, Math.round(ui)));
}

function colorNativeValue(key: DisplayColorKey, ui: number, range: DisplayColorRange): number {
  if (key === 'hue') return snapDisplayColorValue(ui, range);
  const neutral = Number.isFinite(range.default) ? Number(range.default) : (range.min + range.max) / 2;
  const native = ui <= 50
    ? range.min + (neutral - range.min) * (ui / 50)
    : neutral + (range.max - neutral) * ((ui - 50) / 50);
  return snapDisplayColorValue(native, range);
}

function displaySupportText(capability: DisplayCapability<boolean> | undefined): string {
  if (!capability || capability.value === null || capability.value === undefined) return capability?.supported === false ? 'Not supported' : 'Not available';
  return capability.value ? 'Supported' : 'Not supported';
}

function buildDisplayReadonlyRow<T>(title: string, capability: DisplayCapability<T> | undefined, fallbackReason: string): HTMLElement {
  const reason = capability?.reason ?? fallbackReason;
  return el('div', { class: 'display-control display-control-readonly', dataset: { control: title.replace(/\s+/g, '-').toLowerCase() }, title: reason }, [
    el('div', { class: 'display-control-heading' }, [
      el('h3', { class: 'display-control-title', text: title }),
      el('span', { class: 'display-readonly-badge', text: capability?.controllable === true ? 'Read-only' : 'Read-only' }),
    ]),
    el('div', { class: 'display-readonly-value', text: displayCapabilityText(capability) }),
    el('p', { class: 'card-note', text: reason }),
  ]);
}

function buildVariableRefreshRateRow(ctx: PageContext): HTMLElement {
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, 'variableRefreshRate');
  if (!supported) return buildDisplayReadonlyRow('Variable Refresh Rate', display?.variableRefreshRate, DISPLAY_VRR_NOTE);
  const current = displayDraft.variableRefreshRate ?? display?.variableRefreshRate?.value ?? true;
  const select = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: 'variableRefreshRate' },
    onchange: (e: Event) => {
      displayDraft.variableRefreshRate = (e.target as HTMLSelectElement).value === 'enabled';
      refreshDisplayChip('variableRefreshRate');
    },
  }, ['enabled', 'disabled'].map((value) => el('option', {
    value,
    text: VARIABLE_REFRESH_RATE_LABELS[value],
    selected: (value === 'enabled') === current,
  })));
  selectNodes.set('variableRefreshRate', select);
  const row = el('div', { class: 'display-control', dataset: { control: 'variableRefreshRate' } }, [
    el('div', { class: 'display-control-heading' }, [
      el('h3', { class: 'display-control-title', text: 'Variable Refresh Rate' }),
      el('div', { class: 'graphics-control display-inline-control' }, [select]),
    ]),
    el('p', { class: 'card-note', text: DISPLAY_VRR_NOTE }),
    el('div', { class: 'graphics-card-actions' }, [
      el('span', { class: 'chip oc-chip-status', hidden: true }),
      el('button', { class: 'chip chip-btn oc-chip-apply', hidden: true, text: 'Apply', onClick: () => { if (!applying) void applyDisplay(ctx, 'variableRefreshRate'); } }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', onClick: () => {
        const value = display?.variableRefreshRate?.value ?? true;
        displayDraft.variableRefreshRate = value;
        select.value = value ? 'enabled' : 'disabled';
        refreshDisplayChip('variableRefreshRate');
      } }),
    ]),
  ]);
  chipNodes.set('variableRefreshRate', row.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
  chipApplyNodes.set('variableRefreshRate', row.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
  refreshDisplayChip('variableRefreshRate');
  return row;
}

function buildDisplaySlider(ctx: PageContext, key: DisplayColorKey, title: string, capability: DisplayCapability<number> | undefined, fallbackMin: number, fallbackMax: number, fallbackReason: string): HTMLElement {
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, key);
  const range = display?.supportedOptions.colorRanges?.[key];
  const min = range?.min ?? fallbackMin;
  const max = range?.max ?? fallbackMax;
  const step = range?.step ?? 1;
  const nativeValue = capability?.value ?? range?.default ?? 50;
  const uiRange = key === 'hue' ? { min: fallbackMin, max: fallbackMax, step: 1, default: 0 } : { min: 0, max: 100, step: 1, default: 50 };
  const value = colorUiValue(key, nativeValue, { min, max, step, default: range?.default });
  if (!supported) {
    return el('div', { class: 'display-control display-slider-row display-control-readonly', dataset: { control: key } }, [
      el('div', { class: 'display-control-heading' }, [el('h3', { class: 'display-control-title', text: title })]),
      el('div', { class: 'display-slider-line' }, [
        el('input', { class: 'display-number-input', type: 'number', min: uiRange.min, max: uiRange.max, value: capability?.value === null || capability?.value === undefined ? '' : value, disabled: true, 'aria-label': title + ' value' }),
        el('input', { class: 'graphics-slider', type: 'range', min: uiRange.min, max: uiRange.max, step: uiRange.step, value, disabled: true, 'aria-label': title }),
      ]),
      el('p', { class: 'card-note', text: capability?.reason ?? fallbackReason }),
    ]);
  }
  const slider = el('input', {
    class: 'graphics-slider', type: 'range', min: uiRange.min, max: uiRange.max, step: uiRange.step, value, 'aria-label': title,
    oninput: (e: Event) => {
      const nextUi = Number((e.target as HTMLInputElement).value);
      const next = colorNativeValue(key, nextUi, { min, max, step, default: range?.default });
      (displayDraft as Record<string, unknown>)[key] = next;
      numberInput.value = String(nextUi);
      refreshDisplayChip(key);
    },
  });
  const numberInput = el('input', {
    class: 'display-number-input', type: 'number', min: uiRange.min, max: uiRange.max, step: uiRange.step, value, 'aria-label': title + ' value',
    onchange: (e: Event) => {
      const nextUi = Math.min(uiRange.max, Math.max(uiRange.min, Number((e.target as HTMLInputElement).value)));
      if (!Number.isFinite(nextUi)) return;
      (displayDraft as Record<string, unknown>)[key] = colorNativeValue(key, nextUi, { min, max, step, default: range?.default });
      slider.value = String(nextUi);
      numberInput.value = String(nextUi);
      refreshDisplayChip(key);
    },
  });
  const row = el('div', { class: 'display-control display-slider-row', dataset: { control: key } }, [
    el('div', { class: 'display-control-heading' }, [el('h3', { class: 'display-control-title', text: title })]),
    el('div', { class: 'display-slider-line' }, [numberInput, slider]),
    el('p', { class: 'card-note', text: capability?.reason ?? fallbackReason }),
    el('div', { class: 'graphics-card-actions' }, [
      el('span', { class: 'chip oc-chip-status', hidden: true }),
      el('button', { class: 'chip chip-btn oc-chip-apply', hidden: true, text: 'Apply', onClick: () => { if (!applying) void applyDisplay(ctx, key); } }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Reset to default', onClick: () => {
        const resetNative = range
          ? snapDisplayColorValue(range.default ?? nativeValue, range)
          : nativeValue;
        const resetUi = colorUiValue(key, resetNative, { min, max, step, default: range?.default });
        (displayDraft as Record<string, unknown>)[key] = resetNative;
        slider.value = String(resetUi);
        numberInput.value = String(resetUi);
        refreshDisplayChip(key);
      } }),
    ]),
  ]);
  chipNodes.set(key, row.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
  chipApplyNodes.set(key, row.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
  refreshDisplayChip(key);
  return row;
}

function buildDisplayModeRow(title: string, value: string, reason: string): HTMLElement {
  let mode = value.toLowerCase();
  const basic = el('button', { class: 'display-mode-btn', type: 'button', text: 'Basic' });
  const advanced = el('button', { class: 'display-mode-btn', type: 'button', text: 'Advanced' });
  const advancedNote = el('p', { class: 'card-note display-mode-advanced-note', hidden: mode !== 'advanced', text: 'Advanced per-channel controls are not available through the current display control surface.' });
  const sync = (): void => {
    basic.classList.toggle('active', mode === 'basic');
    advanced.classList.toggle('active', mode === 'advanced');
    basic.setAttribute('aria-pressed', String(mode === 'basic'));
    advanced.setAttribute('aria-pressed', String(mode === 'advanced'));
    advancedNote.hidden = mode !== 'advanced';
  };
  basic.onclick = () => { mode = 'basic'; sync(); };
  advanced.onclick = () => { mode = 'advanced'; sync(); };
  sync();
  return el('div', { class: 'display-control display-mode-row' }, [
    el('h3', { class: 'display-control-title', text: title }),
    el('div', { class: 'display-mode-toggle', role: 'group', 'aria-label': title }, [basic, advanced]),
    advancedNote,
    el('p', { class: 'card-note display-mode-description', text: reason }),
  ]);
}

function buildDisplayGroup(key: string, title: string, children: HTMLElement[], open = true): HTMLElement {
  const body = el('div', { class: `display-group-body${open ? '' : ' is-collapsed'}` }, [
    el('div', { class: 'display-group-body-inner' }, children),
  ]);
  const toggle = el('button', {
    class: 'display-group-toggle',
    type: 'button',
    'aria-expanded': String(open),
    onclick: () => {
      const nextOpen = body.classList.toggle('is-collapsed') === false;
      toggle.setAttribute('aria-expanded', String(nextOpen));
      const chevron = toggle.querySelector<HTMLElement>('.display-group-chevron');
      if (chevron) chevron.textContent = nextOpen ? '▾' : '▸';
    },
  }, [
    el('span', { class: 'display-group-chevron', text: open ? '▾' : '▸' }),
    el('span', { class: 'card-title', text: title }),
  ]);
  return el('section', { class: 'card display-group', dataset: { displayGroup: key } }, [toggle, body]);
}

function renderDisplayCards(view: HTMLElement, ctx: PageContext): void {
  clear(view);
  const display = selectedDisplay();
  if (!displayState || !display) {
    // The honest no-controls state (RID_MOCK_DISPLAY_UNSUPPORTED, the
    // multi-device iGPU, any empty display list) - never a dead control,
    // never a crash.
    if (displayPickerHost) clear(displayPickerHost);
    view.append(el('p', { class: 'card-note display-no-displays', text: DISPLAY_NO_DISPLAYS_NOTE }));
    return;
  }

  // The per-display selector (the IGS left-pane analogue) - the first
  // display is the default; a pick re-normalizes the draft + resets the
  // applied reference (the fresh display's state), then rebuilds the cards.
  const picker = el('select', {
    class: 'graphics-select display-picker',
    dataset: { displayPicker: '' },
    onchange: (e: Event) => {
      selectedDisplayId = Number((e.target as HTMLSelectElement).value);
      selectedDisplayKey = displayState?.displays.find((d) => d.id === selectedDisplayId)?.displayKey ?? null;
      displayDraft = normalizeDisplaySettings(selectedDisplay());
      displayScalingViewDraft = scalingViewOf(selectedDisplay());
      displayScalingMethodDraft = scalingMethodViewOf(selectedDisplay());
      setDisplayAppliedScalingBaseline();
      renderDisplayCards(view, ctx);
    },
  }, displayState.displays.map((d) => el('option', {
    value: String(d.id),
    text: d.name ?? `Display ${d.id}`,
    selected: d.id === display.id,
  })));

  const general = buildDisplayGroup('general', 'General', [
    buildDisplayDropdownRow(ctx, 'scalingMode', 'Scaling Mode', DISPLAY_SCALING_NOTE, display.supportedOptions.scalingModes, SCALING_MODE_LABELS),
    buildDisplayScalingMethodRow(ctx),
    buildDisplayDropdownRow(ctx, 'globalVrrMode', 'Variable Refresh Rate Mode', DISPLAY_GLOBAL_VRR_NOTE, display.supportedOptions.globalVrrModes ?? [], GLOBAL_VRR_LABELS),
    buildDisplayDropdownRow(ctx, 'variableRefreshRate', 'Variable Refresh Rate', DISPLAY_VRR_NOTE, ['enabled', 'disabled'], VARIABLE_REFRESH_RATE_LABELS),
  ]);

  const color = buildDisplayGroup('color', 'Color', [
    buildDisplayDropdownRow(ctx, 'quantizationRange', 'Quantization Range', 'The color-quantization range of the display output.', display.supportedOptions.quantizationRanges, QUANTIZATION_LABELS),
  ], false);

  const infoRow = (label: string, value: string): HTMLElement => el('div', { class: 'display-info-row' }, [
    el('span', { class: 'display-info-label', text: label }),
    el('span', { class: 'display-info-value', text: value }),
  ]);
  const info = buildDisplayGroup('info', 'Information', [
    infoRow('Display', display.name ?? '-'),
    infoRow('Graphics Adapter', display.adapterName ?? displayState.adapterName ?? 'Not available'),
    infoRow('Display Connection', display.connection),
    infoRow('Variable Refresh Rate Support', display.variableRefreshRate?.supported === true || display.arcSync.supported ? 'Supported' : 'Not supported'),
    infoRow('Current Variable Refresh Rate Range', display.vrrCurrentRange?.value ?? 'Not available'),
    infoRow('Maximum Variable Refresh Rate Range', display.vrrMaximumRange?.value ?? (display.arcSync.supported ? `${display.arcSync.minRefreshHz ?? '-'} Hz - ${display.arcSync.maxRefreshHz ?? '-'} Hz` : 'Not available')),
    infoRow('HDCP Support', displaySupportText(display.hdcpSupport)),
    infoRow('4K Support', displaySupportText(display.fourKSupport)),
    infoRow('HDR Support', displaySupportText(display.hdrSupport)),
  ], false);

  const pickerRow = el('div', { class: 'display-picker-row' }, [
    el('span', { class: 'display-picker-label', text: 'Display' }),
    picker,
  ]);
  if (displayPickerHost) {
    clear(displayPickerHost);
    displayPickerHost.append(pickerRow);
  }
  displayApplyBtn = el('button', {
    class: 'btn btn-primary btn-sm',
    text: APPLY_BTN_TEXT,
    hidden: true,
    onClick: () => { if (!applying) void applyDisplay(ctx, 'all'); },
  });
  displayResetBtn = el('button', {
    class: 'btn btn-ghost btn-sm',
    text: 'Reset to default',
    onClick: () => {
      resetDisplayDraft(display!);
      renderDisplayCards(view, ctx);
    },
  });
  view.append(
    el('div', { class: 'graphics-general-actions display-general-actions' }, [displayApplyBtn, displayResetBtn]),
    el('div', { class: 'display-stack' }, [general, color, info]),
  );
  updateDisplayFloating();
}

// ---------------------------------------------------------------------------
// Apply (the DEDICATED graphics + display paths)
// ---------------------------------------------------------------------------

// M9: `only` - the per-card apply path: the SAME graphics:apply channel
// with the single key (the payload holds that control alone; the rest of
// the flow - the per-control toasts + the applied reference + the busy
// state - is shared).
async function apply(ctx: PageContext, only?: string) {
  const live = ctx.store.get();
  const deviceId = live.deviceId;
  if (deviceId === null || !graphicsState) return;
  const payload = only !== undefined
    ? (isGraphicsControlDirtyVsApplied(only, draft, graphicsState, applied)
      ? { [only]: (draft as Record<string, unknown>)[only] } as unknown as GraphicsSettings
      : {})
    : buildGraphicsSettings(draft, graphicsState, applied);
  if (!validateGraphicsSettings(payload)) {
    toast('error', 'Apply aborted', 'The graphics payload failed validation - this is a bug.');
    return;
  }
  if (Object.keys(payload).length === 0) {
    updateFloating();
    return;
  }
  // M2C-C: a non-elevated product app delegates the apply to the elevated
  // self-worker (one UAC prompt) - explain BEFORE the prompt. The elevation
  // toast pattern is kept; there is NO OC waiver anywhere in this flow.
  if (live.workerApply && !live.elevated) {
    toast('info', 'Administrator approval needed', ELEVATION_TOAST_TEXT);
  }
  applying = true;
  // M9 review finding 4: the per-card Apply buttons share the busy state
  // (visually disabled while any apply is in flight - the Tuning setBusy
  // parity; clicks were already swallowed by the reentry guard).
  for (const b of chipApplyNodes.values()) b.disabled = true;
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = APPLY_BTN_BUSY_TEXT;
  }
  try {
    const out = await api.graphicsApply(deviceId, payload);
    if (out.graphicsState) {
      graphicsState = out.graphicsState;
    }
    for (const [key, per] of Object.entries(out.perControl)) {
      if (per.ok) {
        (applied as Record<string, unknown>)[key] = (payload as Record<string, unknown>)[key];
        if (!per.internal) toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
      } else {
        // M17d (item 0b): the shared applyFailureText preference - the
        // per-control message wins, the errorCode mapping is the fallback.
        toast('error', `${CONTROL_LABELS[key] ?? key} failed`, applyFailureText(per, key));
      }
    }
    refreshAll();
  } catch (err) {
    // M2C-C: a declined/denied UAC prompt surfaces here with the honest
    // message (Apply requires administrator approval).
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('administrator approval') || msg.includes('Administrator approval')) {
      toast('error', 'Apply requires administrator approval', msg);
    } else {
      toast('error', 'Apply failed', msg);
    }
  } finally {
    applying = false;
    for (const b of chipApplyNodes.values()) b.disabled = false;
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = APPLY_BTN_TEXT;
    }
    updateFloating();
  }
}

/** M10b: the per-card display apply - the SAME display:apply channel with
 *  the single key (the payload holds that control alone). The chip machine
 *  gates the send (an unsupported control is never dirty - the M8 S1
 *  lesson); the FRESH read-back envelope refreshes the display state; the
 *  scaling success carries the honest modeset-flash warning, surfaced via
 *  the apply-result toast. NO OC waiver anywhere in the flow. */
function displayPayloadForControl(only: string, display: DisplayState['displays'][number]): DisplaySettings | null {
  let payload: DisplaySettings = {};
  if (only === 'scalingMode') {
    if (displayScalingViewDraft !== scalingViewOf(display)) {
      const raw = rawScalingForView(display, displayScalingViewDraft);
      payload = { scalingMode: raw };
      if (displayScalingViewDraft === 'gpu-scaling') {
        payload.scalingMode = displayScalingMethodDraft as DisplaySettings['scalingMode'];
        // Keep the IGS method identity alongside the raw IGCL flag. The
        // backend uses this explicit alias to request the physical modeset
        // path, which makes GPU method changes visibly transition the display.
        payload.displayScalingMethod = displayScalingMethodDraft as DisplaySettings['displayScalingMethod'];
      } else if (displayScalingViewDraft === 'display-scaling') {
        payload.scalingMode = raw;
      } else {
        payload.scalingMethod = {
          enabled: true,
          method: displayScalingMethodDraft as NonNullable<DisplaySettings['scalingMethod']>['method'],
        };
      }
      // Retro is a separate adapter-level scaler. Leaving it requires the
      // explicit disable pair to be sent together with the new ordinary mode;
      // otherwise the backend quite correctly keeps Retro enabled.
      if (displayScalingViewDraft !== 'retro-scaling' && display.scalingMethod?.value?.enabled === true) {
        payload.scalingMethod = {
          enabled: false,
          method: display.scalingMethod.value.method ?? 'integer',
        };
      }
      if (payload.scalingMode === 'custom') payload.scalingCustom = customScalingOf(display);
    }
  } else if (only === 'displayScalingMethod') {
    const view = displayScalingViewDraft;
    const customDirty = view === 'display-scaling' && displayScalingMethodDraft === 'custom'
      && !sameCustomScaling(displayDraft.scalingCustom, customScalingOf(display));
    if (displayScalingMethodDraft !== scalingMethodViewOf(display) || customDirty) {
      payload = {};
      if (view === 'gpu-scaling') {
        payload.scalingMode = displayScalingMethodDraft as DisplaySettings['scalingMode'];
        payload.displayScalingMethod = displayScalingMethodDraft as DisplaySettings['displayScalingMethod'];
      } else if (view === 'retro-scaling') {
        payload.scalingMode = rawScalingForView(display, view);
        payload.scalingMethod = {
          enabled: true,
          method: displayScalingMethodDraft as NonNullable<DisplaySettings['scalingMethod']>['method'],
        };
      } else if (displayScalingMethodDraft === 'custom') {
        payload.scalingMode = 'custom';
        payload.scalingCustom = displayDraft.scalingCustom ?? { ...customScalingOf(display), hardwareModeSet: true };
      } else {
        payload.scalingMode = 'identity';
      }
      if (view !== 'retro-scaling' && display.scalingMethod?.value?.enabled === true) {
        payload.scalingMethod = {
          enabled: false,
          method: display.scalingMethod.value.method ?? 'integer',
        };
      }
    }
  } else if (isDisplayControlDirtyVsAppliedPure(only, displayDraft, display, displayApplied)) {
    let value = (displayDraft as Record<string, unknown>)[only];
    if (DISPLAY_COLOR_KEYS.includes(only as DisplayColorKey)) {
      const range = display.supportedOptions.colorRanges?.[only];
      if (range && typeof value === 'number') value = snapDisplayColorValue(value, range);
    }
    payload = { [only]: value } as unknown as DisplaySettings;
  }
  return Object.keys(payload).length > 0 ? payload : null;
}

async function applyDisplay(ctx: PageContext, only: string) {
  if (applying) {
    // A mode change rebuilds the method selector immediately. If the user
    // chooses a method before the first IPC round-trip finishes, keep the
    // latest complete intent instead of dropping it on the busy guard.
    queuedDisplayApply = { ctx, only };
    return;
  }
  const live = ctx.store.get();
  const deviceId = live.deviceId;
  const display = selectedDisplay();
  if (deviceId === null || !display || !displayState) return;
  const payload: DisplaySettings = {};
  if (only === 'all') {
    for (const key of DISPLAY_APPLY_KEYS) {
      const part = displayPayloadForControl(key, display);
      if (part) Object.assign(payload, part);
    }
  } else {
    Object.assign(payload, displayPayloadForControl(only, display) ?? {});
  }
  if (!validateDisplaySettings(payload)) {
    toast('error', 'Apply aborted', 'The display payload failed validation - this is a bug.');
    return;
  }
  if (Object.keys(payload).length === 0) return;
  // M2C-C: a non-elevated product app delegates the apply to the elevated
  // self-worker (one UAC prompt) - explain BEFORE the prompt. The elevation
  // toast pattern is kept; there is NO OC waiver anywhere in this flow.
  if (live.workerApply && !live.elevated) {
    toast('info', 'Administrator approval needed', ELEVATION_TOAST_TEXT);
  }
  applying = true;
  for (const b of chipApplyNodes.values()) b.disabled = true;
  if (only === 'scalingMode' || only === 'displayScalingMethod' || only === 'all') {
    selectNodes.get('scalingMode')?.setAttribute('disabled', 'true');
    selectNodes.get('displayScalingMethod')?.setAttribute('disabled', 'true');
  }
  updateDisplayFloating();
  try {
    const deviceKey = displayState.deviceKey ?? live.devices.find((d) => d.id === deviceId)?.deviceKey ?? null;
    if (!deviceKey || !display.displayKey || display.identityVerified !== true) {
      toast('error', 'Display apply unavailable', 'This display does not have a verified physical identity. Refresh the Display view before applying settings.');
      return;
    }
    const out = await api.displayApply(deviceId, { deviceKey, displayKey: display.displayKey, patch: payload });
    if (out.displayState) {
      displayState = out.displayState;
    }
    const freshDisplay = selectedDisplay();
    for (const [key, per] of Object.entries(out.perControl)) {
      if (per.ok) {
        if (freshDisplay && (key === 'scalingMode' || key === 'displayScalingMethod' || DISPLAY_APPLY_KEYS.includes(key))) {
          const readBackKey = key === 'scalingMode' ? 'scalingMode' : key === 'displayScalingMethod' ? 'displayScalingMethod' : key;
          const readBack = readBackKey === 'scalingMode' ? scalingViewOf(freshDisplay)
            : readBackKey === 'displayScalingMethod' ? scalingMethodViewOf(freshDisplay)
              : displayDriverValue(freshDisplay, readBackKey);
          (displayApplied as Record<string, unknown>)[key] = readBack;
          if (DISPLAY_COLOR_KEYS.includes(key) && typeof readBack === 'number') {
            (displayDraft as Record<string, unknown>)[key] = readBack;
          }
        } else {
          (displayApplied as Record<string, unknown>)[key] = (payload as Record<string, unknown>)[key];
        }
        toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        // The scaling card's honest modeset note rides the apply result
        // (the M10b probe skipped the scaling SET by design - a scaling
        // change is a PHYSICAL MODESET = a screen flash).
        if (per.warning && !per.internal) toast('warn', 'Screen flash expected', per.warning);
      } else {
        toast('error', `${CONTROL_LABELS[key] ?? key} failed`, per.message ?? errorMessage(per.errorCode, key));
      }
    }
    // Scaling Mode and Scaling Method are one IGS three-way control in the
    // UI, but the native payload uses the raw coupled fields. Keep both chip
    // baselines synchronized after either half succeeds; otherwise the
    // method row can remain blue even though the fresh driver state matches.
    if (freshDisplay && (out.perControl.scalingMode?.ok || out.perControl.scalingMethod?.ok || out.perControl.displayScalingMethod?.ok)) {
      (displayApplied as Record<string, unknown>).scalingMode = scalingViewOf(freshDisplay);
      (displayApplied as Record<string, unknown>).displayScalingMethod = scalingMethodViewOf(freshDisplay);
      if (freshDisplay.scalingMethod?.value) displayApplied.scalingMethod = freshDisplay.scalingMethod.value;
    }
    for (const key of DISPLAY_APPLY_KEYS) refreshDisplayChip(key);
    updateDisplayFloating();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('administrator approval') || msg.includes('Administrator approval')) {
      toast('error', 'Apply requires administrator approval', msg);
    } else {
      toast('error', 'Apply failed', msg);
    }
  } finally {
    applying = false;
    for (const b of chipApplyNodes.values()) b.disabled = false;
    selectNodes.get('scalingMode')?.removeAttribute('disabled');
    selectNodes.get('displayScalingMethod')?.removeAttribute('disabled');
    updateDisplayFloating();
    const queued = queuedDisplayApply;
    queuedDisplayApply = null;
    if (queued) setTimeout(() => requestDisplayApply(queued.ctx, queued.only), 0);
  }
}

function requestDisplayApply(ctx: PageContext, only: string): void {
  if (applying) {
    queuedDisplayApply = { ctx, only };
    return;
  }
  void applyDisplay(ctx, only);
}
