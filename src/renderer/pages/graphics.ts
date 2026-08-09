// Arc Power - M8 the Graphics tab (the IGS-mirror page). Four cards in the
// user's order: XeSS Frame Generation Override, Frame Synchronization,
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
// LOADED DRIVER state -> the chip + the floating Apply button appear;
// per-control chips are hidden until the first apply, green "Applied" while
// equal to the last applied, warn "Unapplied" when different. The
// supported-features caps gate the cards ('Not supported on this GPU.' -
// no control); the driver's SupportedTypes gate the dropdown options
// (Speed Sync / On + Boost only when the driver exposes them - the honest
// probe record).
//
// The no-Intel guard renders FIRST (deviceId null -> 'No GPU available.') -
// graphics:get is NEVER called with a null deviceId (assertValidDeviceId
// would throw).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
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
const CARD_NOTES: Record<string, string> = {
  frameGenOverride: "Sets the driver's XeSS frame-generation override for games that use XeSS Frame Generation (the game may need a restart for the change to apply).",
  flipMode: 'The driver\'s frame-synchronization mode (VSync / Smooth Sync / Speed Sync). Smart VSync is not exposed by the driver interface.',
  frameLimit: 'A driver-level frame-rate cap. The limiter works independently of Arc Power.',
  lowLatency: 'The driver\'s XeLL-based low-latency mode.',
};
const PAGE_NOTE = 'These settings are applied via the Intel driver\'s control interface (the same state the Intel Graphics Software app manages). Per-game profiles stay in Intel Graphics Software - this tab applies the global settings.';

const CARD_TITLES: Record<string, string> = {
  frameGenOverride: 'XeSS Frame Generation Override',
  flipMode: 'Frame Synchronization',
  frameLimit: 'FPS Limit',
  lowLatency: 'Low Latency Mode',
};

const DROPDOWN_LABELS: Record<string, Record<string, string>> = {
  frameGenOverride: { 'app-choice': 'Application Default', '2x': '2x Frame Generation', '3x': '3x Frame Generation', '4x': '4x Frame Generation' },
  flipMode: { 'application-default': 'Application Choice', 'vsync-on': 'Enable VSync', 'vsync-off': 'Disable VSync', 'smooth-sync': 'Smooth Sync', 'speed-frame': 'Speed Sync' },
  lowLatency: { off: 'Off', on: 'On', 'on-boost': 'On + Boost' },
};

// The dropdown default (a "Reset to default" target): the FIRST SUPPORTED
// option - the probe + the mock + the driver's caps DefaultType all agree
// (app-choice / application-default / off).
const DROPDOWN_OPTIONS: Record<string, string[]> = {
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
const valueNodes = new Map<string, HTMLElement>();
const sliderNodes = new Map<string, HTMLInputElement>();
const toggleNodes = new Map<string, HTMLInputElement>();
const selectNodes = new Map<string, HTMLSelectElement>();
let viewContainer: HTMLElement | null = null;

function resetPageState() {
  graphicsState = null;
  draft = {};
  applied = {};
  applying = false;
  applyBtn = null;
  chipNodes.clear();
  valueNodes.clear();
  sliderNodes.clear();
  toggleNodes.clear();
  selectNodes.clear();
  viewContainer = null;
}

/** M3-C-G chip semantics (the Tuning pattern): hidden until the first apply
 *  of this control; green "Applied" while the draft equals the last applied;
 *  warn "Unapplied" once the value differs after applying. */
function refreshChip(key: string) {
  const chip = chipNodes.get(key);
  if (!chip) return;
  if (!(key in applied)) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const ok = !isAppliedDiffers(key);
  chip.textContent = ok ? 'Applied' : 'Unapplied';
  chip.className = `chip oc-chip-status ${ok ? 'chip-ok' : 'chip-warn'}`;
}

function isAppliedDiffers(key: string): boolean {
  const wanted = (draft as Record<string, unknown>)[key];
  const appliedValue = (applied as Record<string, unknown>)[key];
  if (key === 'frameLimit') {
    const a = wanted as { enabled: boolean; value: number } | undefined;
    const b = appliedValue as { enabled: boolean; value: number } | undefined;
    if (!a || !b) return a !== b;
    return a.enabled !== b.enabled || a.value !== b.value;
  }
  return wanted !== appliedValue;
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

    let state: GraphicsState;
    try {
      state = await api.graphicsGet(s.deviceId);
    } catch (err) {
      clear(viewContainer);
      viewContainer.append(el('p', { class: 'text-error', text: `Graphics settings unavailable: ${err instanceof Error ? err.message : String(err)}` }));
      return;
    }
    graphicsState = state;
    draft = normalizeGraphicsSettings(state);
    renderCards(viewContainer, ctx);
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
// Cards
// ---------------------------------------------------------------------------

function supportedOf(state: GraphicsState, key: string): boolean {
  switch (key) {
    case 'frameGenOverride': return state.supported.frameGen;
    case 'flipMode': return state.supported.flipModes;
    case 'frameLimit': return state.supported.frameLimit;
    case 'lowLatency': return state.supported.lowLatency;
    default: return false;
  }
}

function optionsOf(state: GraphicsState, key: string): string[] {
  switch (key) {
    case 'frameGenOverride': return state.supportedOptions.frameGen;
    case 'flipMode': return state.supportedOptions.flipModes;
    case 'lowLatency': return state.supportedOptions.lowLatency;
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
    const toggle = el('input', {
      type: 'checkbox',
      class: 'settings-checkbox graphics-toggle',
      dataset: { graphicsToggle: 'frameLimit' },
      checked: fl.enabled,
      onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        draft.frameLimit = { enabled: on, value: on ? clampFrameLimitValue(fl.value, range) : fl.value };
        const slider = sliderNodes.get('frameLimit');
        if (slider) slider.hidden = !on;
        refreshChip('frameLimit');
        updateFloating();
      },
    });
    toggleNodes.set('frameLimit', toggle);
    const slider = el('input', {
      type: 'range',
      class: 'graphics-slider',
      min: range.min,
      max: range.max,
      step: range.step,
      value: clampFrameLimitValue(fl.value, range),
      hidden: !fl.enabled,
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
    const card = el('section', { class: 'card graphics-card', dataset: { control: 'frameLimit' } }, [
      el('h2', { class: 'card-title', text: CARD_TITLES.frameLimit }),
      el('p', { class: 'card-note', text: CARD_NOTES.frameLimit }),
      el('div', { class: 'graphics-fps-row' }, [
        el('label', { class: 'graphics-toggle-label' }, [
          toggle,
          el('span', { text: 'Limit the frame rate' }),
        ]),
        el('div', { class: 'graphics-fps-slider-row' }, [
          slider,
          valueNode,
        ]),
      ]),
      el('div', { class: 'graphics-card-actions' }, [
        el('span', { class: 'chip oc-chip-status', hidden: true }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: 'Reset to default',
          onClick: () => {
            draft.frameLimit = { enabled: false, value: range.default };
            const t = toggleNodes.get('frameLimit');
            if (t) t.checked = false;
            const sl = sliderNodes.get('frameLimit');
            if (sl) {
              sl.hidden = true;
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
    refreshChip('frameLimit');
    return card;
  };

  // The four cards in the user's order (plan 2): FG override, Frame Sync,
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

async function apply(ctx: PageContext) {
  const live = ctx.store.get();
  const deviceId = live.deviceId;
  if (deviceId === null || !graphicsState) return;
  const payload = buildGraphicsSettings(draft, graphicsState, applied);
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
        toast('error', `${CONTROL_LABELS[key] ?? key} failed`, per.message ?? errorMessage(per.errorCode, key));
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
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = APPLY_BTN_TEXT;
    }
    updateFloating();
  }
}
