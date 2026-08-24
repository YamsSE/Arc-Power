// Arc Power - M8 the Graphics tab (the IGS-mirror page). Four cards in the
// planned order: XeSS Frame Generation Override, Frame Synchronization,
// FPS Limit, Low Latency. The page mirrors Intel Graphics Software (IGS):
// every setting is a real IGCL 3D feature (ctlGetSupported3DCapabilities /
// ctlGetSet3DFeature - live-verified settable on this driver by the M8
// checkpoint-1 probe).
//
// M10b: the page gains a second view mode - "Graphics | Display" (the M9
// Monitoring-view pattern: the segmented pill + the view container + the
// module view state). The Display view mirrors the IGS "Display" tab: the
// per-display selector, GENERAL (scaling + the honest scaling-method/VRR
// notes), COLOR (quantization + the wire-format controls + the honest
// sliders note) and INFORMATION (the read-only rows). The M10b
// checkpoint-1 probe recorded this driver's honest surface: the wire-format
// SET is a silent no-op (wireFormats/bpcDepths come back EMPTY - the
// color format/depth controls show the honest read-only state), and the
// scaling-method + VRR surfaces are not exposed (the honest notes).
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

// The honest notes (plan 2.3 - one per card).
// M23: EXPORTED - the ADVANCED overlay's Graphics tab imports them (export,
// never duplicate - the option lists/labels/titles/notes are the single
// source both surfaces render from).
export const CARD_NOTES: Record<string, string> = {
  frameGenOverride: "Sets the driver's XeSS frame-generation override for games that use XeSS Frame Generation (the game may need a restart for the change to apply).",
  flipMode: 'The driver\'s frame-synchronization mode (VSync / Smooth Sync / Speed Sync). Smart VSync is not exposed by the driver interface.',
  frameLimit: 'A driver-level frame-rate cap. The limiter works independently of Arc Power.',
  lowLatency: 'The driver\'s XeLL-based low-latency mode.',
};
const PAGE_NOTE = 'These settings are applied via the Intel driver\'s control interface (the same state the Intel Graphics Software app manages). Per-game profiles stay in Intel Graphics Software - this tab applies the global settings.';

// M10b: the Display view's honest notes (plan 2.4 - the IGS "Display" tab
// mirror; the M10b checkpoint-1 probe recorded what this driver exposes).
const DISPLAY_SCALING_NOTE = 'Changing the scaling mode causes a brief screen flash (a physical modeset).';
// DECISION (documented): the Scaling Method row ALWAYS renders the honest
// note - the driver's scalingMethods list is EMPTY on this driver build
// (the probe record) and the apply interface defines no scaling-method
// patch key, so a control would be un-appliable on every current driver.
// The scope's alternative (hiding the row) would silently drop an IGS
// section to be mirrored.
const DISPLAY_SCALING_METHOD_NOTE = 'Not exposed by the driver interface.';
// The VRR fields render only when the driver reports a VRR surface - this
// driver reports none (the DisplayState interface has no VRR fields), so
// the honest note is unconditional. The plain VRR on/off is OS-controlled
// in Windows (plan 5 - out of scope).
const DISPLAY_VRR_NOTE = 'Variable refresh rate is OS-controlled in Windows; the driver does not expose a VRR-mode surface here.';
const DISPLAY_SLIDERS_NOTE = 'The Hue/Saturation/Brightness/Contrast calibration sliders are not exposed by the public driver interface - they are applied by the Intel Graphics Software service';
const DISPLAY_WIRE_READONLY_NOTE = 'The wire-format set is a silent no-op on this driver build - the driver does not accept wire-format changes (the read-back never changes).';
const DISPLAY_NO_DISPLAYS_NOTE = 'No display settings are available on this GPU.';

export const CARD_TITLES: Record<string, string> = {
  frameGenOverride: 'XeSS Frame Generation Override',
  flipMode: 'Frame Synchronization',
  frameLimit: 'FPS Limit',
  lowLatency: 'Low Latency Mode',
};

export const DROPDOWN_LABELS: Record<string, Record<string, string>> = {
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

// The dropdown default (a "Reset to default" target): the FIRST SUPPORTED
// option - the probe + the mock + the driver's caps DefaultType all agree
// (app-choice / application-default / off).
export const DROPDOWN_OPTIONS: Record<string, string[]> = {
  frameGenOverride: FRAME_GEN_OPTIONS,
  flipMode: FLIP_MODE_OPTIONS,
  lowLatency: LOW_LATENCY_OPTIONS,
};

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
let applying = false;
let applyBtn: HTMLButtonElement | null = null;
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
  const pushed = normalizeGraphicsSettings(payload.graphicsState);
  for (const key of ['frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency']) {
    if (key in applied) continue;
    (draft as Record<string, unknown>)[key] = (pushed as Record<string, unknown>)[key];
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
  applying = false;
  applyBtn = null;
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

/** M10b: the Display view's chip machine - the same chipState call with the
 *  display-side driver value + the supportedOptions gate (an optionless
 *  control - the wire-format surface on this driver build - is never dirty
 *  and never shows an Apply button). */
function refreshDisplayChip(key: string) {
  const chip = chipNodes.get(key);
  if (!chip) return;
  const display = selectedDisplay();
  const state = chipState(
    key,
    displayDraft as Record<string, unknown>,
    displayApplied as Record<string, unknown>,
    displayDriverValue(display, key),
    isDisplayControlSupported(display, key),
  );
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
}

function updateFloating() {
  if (!applyBtn) return;
  if (applying) return;
  applyBtn.hidden = !computeGraphicsDirty(draft, graphicsState, applied);
}

function refreshAll() {
  for (const key of ['frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency']) refreshChip(key);
  updateFloating();
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
      el('p', { class: 'card-note graphics-page-note', text: PAGE_NOTE }),
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
    case 'frameGenOverride': return state.supportedOptions.frameGen;
    case 'flipMode': return state.supportedOptions.flipModes;
    case 'lowLatency': return LOW_LATENCY_OPTIONS;
    default: return [];
  }
}

function renderCards(view: HTMLElement, ctx: PageContext) {
  clear(view);
  const state = graphicsState;
  if (!state) return;

  // The floating Apply exists ONLY when at least one feature is supported -
  // an all-false session (the honest degrade) has nothing to apply (the
  // null driver values would otherwise count as dirty and show the button).
  const anySupported = state.supported.frameGen || state.supported.flipModes
    || state.supported.frameLimit || state.supported.lowLatency;
  applyBtn = anySupported ? el('button', { class: 'btn btn-primary floating-apply', text: APPLY_BTN_TEXT }) : null;
  applyBtn?.addEventListener('click', () => {
    if (applying) return;
    void apply(ctx);
  });

  const buildDropdownCard = (key: string): HTMLElement => {
    const supported = supportedOf(state, key);
    if (!supported) {
      return el('section', { class: 'card graphics-card graphics-unsupported', dataset: { control: key } }, [
        el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
        el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
      ]);
    }
    const options = optionsOf(state, key);
    if (options.length === 0) {
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
      el('h2', { class: 'card-title', text: CARD_TITLES[key] }),
      el('p', { class: 'card-note', text: CARD_NOTES[key] }),
      el('div', { class: 'graphics-control' }, [select]),
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
            (draft as Record<string, unknown>)[key] = options[0];
            const sel = selectNodes.get(key);
            if (sel) sel.value = options[0];
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
      el('h2', { class: 'card-title', text: CARD_TITLES.frameLimit }),
      el('p', { class: 'card-note', text: CARD_NOTES.frameLimit }),
      el('div', { class: 'graphics-fps-row' }, [
        el('div', { class: 'graphics-control' }, [toggle]),
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

  // The four cards in the planned order (plan 2): FG override, Frame Sync,
  // FPS Limit, Low Latency.
  view.append(
    el('div', { class: 'card-stack graphics-stack' }, [
      buildDropdownCard('frameGenOverride'),
      buildDropdownCard('flipMode'),
      buildFrameLimitCard(),
      buildDropdownCard('lowLatency'),
      ...(applyBtn ? [applyBtn as Node] : []),
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
  displayApplied = {};
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
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, key);
  if (!supported || options.length === 0) {
    return el('div', { class: 'display-control display-control-readonly', dataset: { control: key } }, [
      el('h3', { class: 'display-control-title', text: title }),
      el('p', { class: 'card-note', text: 'Not supported on this GPU.' }),
    ]);
  }
  const current = (displayDraft as Record<string, unknown>)[key] as string;
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
    el('h3', { class: 'display-control-title', text: title }),
    el('p', { class: 'card-note', text: note }),
    el('div', { class: 'graphics-control' }, [select]),
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
          (displayDraft as Record<string, unknown>)[key] = options[0];
          const sel = selectNodes.get(key);
          if (sel) sel.value = options[0];
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

/** M10b: the wire-format control row - ONE card holding the two IGS-style
 *  selects (Color Format + Color Depth) that compose the single wireFormat
 *  patch key { model, depth }. The M8 S1 lesson: on this driver build the
 *  wire-format surface is read-only in effect (wireFormats/bpcDepths come
 *  back EMPTY) - the row then shows the honest read-only state (the current
 *  values + the silent-no-op note), never a dead control. */
function buildWireFormatRow(ctx: PageContext): HTMLElement {
  const display = selectedDisplay();
  const supported = display !== null && isDisplayControlSupported(display, 'wireFormat');
  if (!supported) {
    return el('div', { class: 'display-control display-control-readonly', dataset: { control: 'wireFormat' } }, [
      el('h3', { class: 'display-control-title', text: 'Wire Format' }),
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
  const wf: NonNullable<DisplaySettings['wireFormat']> = displayDraft.wireFormat ?? {
    model: display!.supportedOptions.wireFormats[0] as NonNullable<DisplaySettings['wireFormat']>['model'],
    depth: display!.supportedOptions.bpcDepths[0],
  };
  const modelSelect = el('select', {
    class: 'graphics-select display-select',
    dataset: { displaySelect: 'colorFormat' },
    onchange: (e: Event) => {
      displayDraft.wireFormat = { model: (e.target as HTMLSelectElement).value as NonNullable<DisplaySettings['wireFormat']>['model'], depth: wf.depth };
      refreshDisplayChip('wireFormat');
    },
  }, display!.supportedOptions.wireFormats.map((o) => el('option', {
    value: o,
    text: o,
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
    el('h3', { class: 'display-control-title', text: 'Wire Format' }),
    el('p', { class: 'card-note', text: 'The driver-level wire format of the display output (color model + bit depth).' }),
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
          displayDraft.wireFormat = { model: display!.supportedOptions.wireFormats[0] as NonNullable<DisplaySettings['wireFormat']>['model'], depth: display!.supportedOptions.bpcDepths[0] };
          const m = selectNodes.get('wireFormat');
          if (m) m.value = display!.supportedOptions.wireFormats[0];
          const d = selectNodes.get('wireFormatDepth');
          if (d) d.value = String(display!.supportedOptions.bpcDepths[0]);
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

function buildDisplayReadonlySlider(title: string, capability: DisplayCapability<number> | undefined, min: number, max: number, fallbackReason: string): HTMLElement {
  const value = capability?.value ?? 50;
  return el('div', { class: 'display-control display-slider-row display-control-readonly', dataset: { control: title.toLowerCase() } }, [
    el('div', { class: 'display-control-heading' }, [el('h3', { class: 'display-control-title', text: title })]),
    el('div', { class: 'display-slider-line' }, [
      el('input', { class: 'graphics-slider', type: 'range', min, max, value, disabled: true, 'aria-label': title }),
      el('input', { class: 'display-number-input', type: 'number', min, max, value: capability?.value ?? '', disabled: true, 'aria-label': `${title} value` }),
    ]),
    el('p', { class: 'card-note', text: capability?.reason ?? fallbackReason }),
  ]);
}

function buildDisplayModeRow(title: string, value: string, reason: string): HTMLElement {
  return el('div', { class: 'display-control display-mode-row display-control-readonly' }, [
    el('h3', { class: 'display-control-title', text: title }),
    el('div', { class: 'display-mode-toggle disabled', role: 'group', 'aria-label': title }, [
      el('button', { class: 'display-mode-btn active', type: 'button', disabled: true, text: value }),
      el('button', { class: 'display-mode-btn', type: 'button', disabled: true, text: 'Advanced' }),
    ]),
    el('p', { class: 'card-note', text: reason }),
  ]);
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
      displayApplied = {};
      renderDisplayCards(view, ctx);
    },
  }, displayState.displays.map((d) => el('option', {
    value: String(d.id),
    text: d.name ?? `Display ${d.id}`,
    selected: d.id === display.id,
  })));

  const general = el('section', { class: 'card display-group', dataset: { displayGroup: 'general' } }, [
    el('h2', { class: 'card-title', text: 'General' }),
    buildDisplayDropdownRow(ctx, 'scalingMode', 'Scaling Mode', DISPLAY_SCALING_NOTE, display.supportedOptions.scalingModes, SCALING_MODE_LABELS),
    buildDisplayReadonlyRow('Scaling Method', display.scalingMethod, DISPLAY_SCALING_METHOD_NOTE),
    buildDisplayReadonlyRow('Variable Refresh Rate Mode', display.vrrMode, DISPLAY_VRR_NOTE),
    buildDisplayReadonlyRow('Variable Refresh Rate', display.variableRefreshRate, DISPLAY_VRR_NOTE),
  ]);

  const color = el('section', { class: 'card display-group', dataset: { displayGroup: 'color' } }, [
    el('h2', { class: 'card-title', text: 'Color' }),
    buildDisplayReadonlySlider('Hue', display.hue, -180, 180, DISPLAY_SLIDERS_NOTE),
    buildDisplayReadonlySlider('Saturation', display.saturation, 0, 100, DISPLAY_SLIDERS_NOTE),
    buildDisplayModeRow('Brightness', 'Basic', DISPLAY_SLIDERS_NOTE),
    buildDisplayReadonlySlider('All', display.brightness, 0, 100, DISPLAY_SLIDERS_NOTE),
    buildDisplayModeRow('Contrast', 'Basic', DISPLAY_SLIDERS_NOTE),
    buildDisplayReadonlySlider('All', display.contrast, 0, 100, DISPLAY_SLIDERS_NOTE),
    buildDisplayDropdownRow(ctx, 'quantizationRange', 'Quantization Range', 'The color-quantization range of the display output.', display.supportedOptions.quantizationRanges, QUANTIZATION_LABELS),
    buildWireFormatRow(ctx),
  ]);

  const infoRow = (label: string, value: string): HTMLElement => el('div', { class: 'display-info-row' }, [
    el('span', { class: 'display-info-label', text: label }),
    el('span', { class: 'display-info-value', text: value }),
  ]);
  const info = el('section', { class: 'card display-group', dataset: { displayGroup: 'info' } }, [
    el('h2', { class: 'card-title', text: 'Information' }),
    infoRow('Display', display.name ?? '-'),
    infoRow('Graphics Adapter', display.adapterName ?? displayState.adapterName ?? 'Not available'),
    infoRow('Display Connection', display.connection),
    infoRow('Variable Refresh Rate Support', display.variableRefreshRate?.supported === true || display.arcSync.supported ? 'Supported' : 'Not supported'),
    infoRow('Current Variable Refresh Rate Range', display.vrrCurrentRange?.value ?? 'Not available'),
    infoRow('Maximum Variable Refresh Rate Range', display.vrrMaximumRange?.value ?? (display.arcSync.supported ? `${display.arcSync.minRefreshHz ?? '-'} Hz - ${display.arcSync.maxRefreshHz ?? '-'} Hz` : 'Not available')),
    infoRow('HDCP Support', displaySupportText(display.hdcpSupport)),
    infoRow('4K Support', displaySupportText(display.fourKSupport)),
    infoRow('HDR Support', displaySupportText(display.hdrSupport)),
  ]);

  const pickerRow = el('div', { class: 'display-picker-row' }, [
    el('span', { class: 'display-picker-label', text: 'Display' }),
    picker,
  ]);
  if (displayPickerHost) {
    clear(displayPickerHost);
    displayPickerHost.append(pickerRow);
  }
  view.append(el('div', { class: 'display-stack' }, [general, color, info]));
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
        toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
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
async function applyDisplay(ctx: PageContext, only: string) {
  const live = ctx.store.get();
  const deviceId = live.deviceId;
  const display = selectedDisplay();
  if (deviceId === null || !display || !displayState) return;
  const payload = isDisplayControlDirtyVsAppliedPure(only, displayDraft, display, displayApplied)
    ? { [only]: (displayDraft as Record<string, unknown>)[only] } as unknown as DisplaySettings
    : {};
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
    for (const [key, per] of Object.entries(out.perControl)) {
      if (per.ok) {
        (displayApplied as Record<string, unknown>)[key] = (payload as Record<string, unknown>)[key];
        toast('success', `${CONTROL_LABELS[key] ?? key} applied`, '');
        // The scaling card's honest modeset note rides the apply result
        // (the M10b probe skipped the scaling SET by design - a scaling
        // change is a PHYSICAL MODESET = a screen flash).
        if (per.warning) toast('warn', 'Screen flash expected', per.warning);
      } else {
        toast('error', `${CONTROL_LABELS[key] ?? key} failed`, per.message ?? errorMessage(per.errorCode, key));
      }
    }
    refreshDisplayChip(only);
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
  }
}
