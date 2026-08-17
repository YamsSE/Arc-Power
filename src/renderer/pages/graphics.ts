// Arc Power - M8 the Graphics tab (the IGS-mirror page). Four cards in the
// planned order: XeSS Frame Generation Override, Frame Synchronization,
// FPS Limit, Low Latency. The page mirrors Intel Graphics Software (IGS):
// every setting is a real IGCL 3D feature (ctlGetSupported3DCapabilities /
// ctlGetSet3DFeature - live-verified settable on this driver by the M8
// checkpoint-1 probe).
//
// The DEDICATED graphics apply path (plan-review S1): the page NEVER rides
// the OC apply-routing machinery - the 'graphics:apply' IPC channel + the
// 'graphics-apply' worker op. NO OC waiver anywhere in the flow; the
// elevation toast pattern (workerApply && !elevated) is kept - the worker
// still spawns elevated for the packaged app.
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
// graphics:get is NEVER called with a null deviceId (assertValidDeviceId
// would throw).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { applyFailureText, CONTROL_LABELS } from '../pure/errors.ts';
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
import type { FrameGenOverride, FlipMode, GraphicsSettings, GraphicsState, LowLatency } from '../types.ts';

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

function resetPageState() {
  graphicsState = null;
  draft = {};
  applied = {};
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

    // The deviceId-null guard runs FIRST (plan-review S3): on the no-Intel
    // path deviceId is null and graphics:get must NEVER be called with it
    // (assertValidDeviceId throws) - the honest answer is the Tuning-style
    // 'No GPU available.' guard.
    if (s.deviceId === null) {
      container.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
      return;
    }

    // The page shell renders immediately; the driver state loads async (the
    // page's ONLY IPC surface - graphicsGet).
    viewContainer = el('div', { class: 'graphics-view' });
    container.append(
      el('h1', { class: 'page-title', text: 'Graphics' }),
      el('p', {
        class: 'page-subtitle',
        text: 'Driver-level graphics settings (the same state the Intel Graphics Software app manages). Changes apply on demand - nothing is applied until you press Apply.',
      }),
      el('p', { class: 'card-note graphics-page-note', text: PAGE_NOTE }),
      viewContainer,
    );
    viewContainer.append(el('p', { class: 'page-subtitle', text: 'Loading graphics capabilities…' }));
    await renderSettingsView(viewContainer, ctx);
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // The graphics state is page-owned (loaded via the graphicsGet IPC at
    // render; the apply envelope carries the fresh read-back). A device
    // switch / featureset swap re-renders the whole page via the router.
    // Nothing to refresh from the store's OC slots - the guard below keeps
    // a stale render from crashing on a mid-switch null deviceId.
    const s = ctx.store.get();
    if (s.deviceId === null && graphicsState !== null) {
      graphicsPage.render(container, ctx);
    }
  },
};

// ---------------------------------------------------------------------------
// The Graphics (settings) view - the M8 cards
// ---------------------------------------------------------------------------

/** M8: the settings view load + cards. The state is page-owned: every
 *  rebuild re-fetches via graphicsGet (fresh) and re-registers the node
 *  maps (the S2 re-registration contract). */
async function renderSettingsView(view: HTMLElement, ctx: PageContext): Promise<void> {
  const s = ctx.store.get();
  if (s.deviceId === null) return; // the render guard already handled this
  clear(view);
  view.append(el('p', { class: 'page-subtitle', text: 'Loading graphics capabilities…' }));
  let state: GraphicsState;
  try {
    state = await api.graphicsGet(s.deviceId);
  } catch (err) {
    clear(view);
    view.append(el('p', { class: 'text-error', text: `Graphics settings unavailable: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
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
// Apply (the DEDICATED graphics path)
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
