// Arc Power — Tuning page (M4-D2 §7/§8: renamed from Overclocking; the Fan
// page merged in as a sub-view). One card per supported control (slider,
// clamps, per-card reset), the M3-C-E OC-mode segmented toggle (Stock /
// Advanced with the beyond-Intel disclaimer), the Advanced disclosure for
// expert controls, and a floating Apply button anchored bottom-left that
// appears ONLY when a setting differs from the loaded driver state (dirty)
// and disappears when clean.
//
// M4-D2 (§8): the OC-mode row is a FLEX ROW — LEFT the Stock/Advanced pill
// (unchanged), RIGHT a second segmented pill "Tuning | Fan Curve" (same
// height, same styling) switching the page content between the tuning
// controls and the fan curve editor (pages/fan-editor.ts — the old Fan
// page's editor extracted into a shared module). The view persists per
// render (module state, default 'tuning'); the old #/fan hash redirects
// here with the fan view active (router.ts consumeFanViewRequest).
//
// M2C-B F3 (instant apply): ONE attempt per control, zero waiting, no
// progress UI, no cancellation, no retry note. Refusals (incl. the silent
// no-op) toast the actionable message composed in main.
//
// M2C-B B5: the chip + floating Apply use the APPLIED reference (per-
// `result.ok` control -> the applied value), so they clear immediately even
// when the driver read-back lags; the no-op toast suppression still
// compares against the pre-apply driver read-back.
//
// M3-C-D (double-dialog decision): there is NO per-apply extended-range
// confirm on this page — in Advanced mode the mode-enable confirm already
// warned; in Stock mode the shared oc-mode gate refuses extended values
// with a toast (the slider max is pinned to the standard limit anyway).
//
// M3-C-F (dynamic refresh): after an apply EVERY card refreshes from the
// fresh device state — the "Driver:" readout (previously built once at
// render — the stale part that forced the leave-and-return dance), the
// slider, the chips. The page onUpdate refreshes the cards in place when
// the store's state slot changes (apply from any path / profile load /
// tray apply), and fully re-renders only when the capability surface
// changes (mode toggle / featureset swap). The refresh decision lives in
// the pure helpers ocStateChanged / ocCapsChanged (unit-tested).
//
// M3-C-G: the per-card Stock/Medium/Max preset chips are REMOVED (the pure
// computePresets stays for other consumers). Per-control chip states:
// hidden until the first apply of that control, green "Applied" while the
// current value equals the last applied value, warn "Unapplied" once the
// value differs after applying. "Reset to default" stays.
//
// M4-B: (1) the offset ranges mirror into the negative half-plane (the UI
// math is range-driven — no special-casing); (2) the GPU-frequency-offset
// card gets the Offset/Clock segmented toggle (Wattman-style): Clock mode
// slides/reads out the ABSOLUTE clock (base = device.graphicsClockMHz,
// captured at render, stable per session) while the stored/applied value
// stays the offset (IGCL only accepts offsets — pure/clock.ts converts);
// (3) the gpuLock editor card ships in the Advanced section (Voltage +
// Frequency inputs + Apply/Reset, gated on caps.controls.gpuLock — the
// backend apply paths already existed); (4) expert-row texts are honest:
// gpuLock = "Editing available", vfCurve/VRAM rows = "M5" (no apply path).
//
// M4-D (user): the Advanced (expert) section renders ONLY rows whose
// control is SUPPORTED on the device (caps.controls[row.control] === true —
// the IGCL-keyed caps key, M4-D review F1) — the "Unsupported on this GPU"
// rows are REMOVED entirely (they said nothing the empty space could not);
// supported-but-M5 rows keep their honest note.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { consumeFanViewRequest } from '../router.ts';
import { api } from '../ipc.ts';
import { snapToRange, normalizedPosition, formatValue, formatDriverValue, isOffGrid } from '../pure/slider.ts';
import { clockToOffset, offsetToClock, clockRangeFromOffsetRange } from '../pure/clock.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
import { buildScalarSettings, validateSettingsPayload, isNoopApply, computeDirtyVsApplied, isScalarDirtyVsApplied, ocStateChanged, ocCapsChanged, cardSliderRange, parseGpuLockInput, gpuLockToastPair } from '../pure/settings.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { showAdvancedModeConfirm } from '../components/confirm-dialog.ts';
import { toast } from '../components/toast.ts';
import { buildDeviceSelect } from '../components/device-select.ts';
import { selectDevice } from '../app.ts';
import { renderFanEditor, updateFanReadout } from './fan-editor.ts';
import type { RangeInfo, Capabilities, DeviceState, OcMode } from '../types.ts';

// The pure refresh-signature helpers live in pure/settings.ts (unit-tested
// there); this page re-exports them so the import surface stays local.
export { ocStateChanged, ocCapsChanged } from '../pure/settings.ts';

// Display order only — support comes from caps.ranges, limits from the ranges.
const CONTROL_ORDER = ['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'powerLimitW', 'tempLimitC'];
// M4-B: per-control expert status. gpuLock ships an editor in the Advanced
// section ("Editing available"); vfCurve + VRAM offsets have NO apply path
// yet — honest "editing arrives in M5".
// M4-D (user): only SUPPORTED controls render (caps.controls[row.control] ===
// true); the "Unsupported on this GPU" rows are removed entirely.
// M4-D review F1: `key` is the CANONICAL settings/state key (the expert-value
// read below uses it); `control` is the caps.controls key (IGCL-keyed in BOTH
// backends — vramFreqOffset/vramVoltOffset, not the canonical
// vramFreqOffsetGts/vramVoltOffsetV). The supported filter MUST key on
// `control`: keying on the canonical name reads undefined for the two VRAM
// rows and drops them even on devices that support the control (b580, real
// discrete Arcs). gpuLock/vfCurve are identical in both namespaces.
const EXPERT_CONTROLS: Array<{ key: string; control: string; label: string; note: string }> = [
  { key: 'gpuLock', control: 'gpuLock', label: 'GPU lock (voltage/frequency pair)', note: 'Editing available' },
  { key: 'vfCurve', control: 'vfCurve', label: 'Custom VF curve', note: 'Supported — editing arrives in M5' },
  { key: 'vramFreqOffsetGts', control: 'vramFreqOffset', label: 'VRAM frequency offset', note: 'Supported — editing arrives in M5' },
  { key: 'vramVoltOffsetV', control: 'vramVoltOffset', label: 'VRAM voltage offset', note: 'Supported — editing arrives in M5' },
];

export const APPLY_BTN_TEXT = 'Apply';
export const APPLY_BTN_BUSY_TEXT = 'Applying…';
// M2C-C first-apply elevation explanation: shown right before the UAC prompt
// (a short toast — the prompt itself is the OS's, this explains why).
export const ELEVATION_TOAST_TEXT = 'Administrator approval is needed to apply GPU settings.';
export const ELEVATION_CANCELED_TEXT = 'Apply requires administrator approval.';

// ---------------------------------------------------------------------------
// Page (per-render mutable state hoisted so onUpdate can refresh in place —
// only one page renders at a time, same pattern as the dashboard)
// ---------------------------------------------------------------------------

function supportedScalars(caps: Capabilities): string[] {
  return CONTROL_ORDER.filter((k) => caps.ranges[k] !== undefined);
}

let values: Record<string, number> = {};
let currentState: DeviceState | null = null;
let applied: Record<string, number> = {};
let lastRenderedCaps: Capabilities | null = null;
let renderCaps: Capabilities | null = null;
// M4-B: the freq card's Offset/Clock mode ('clock' = the slider sets an
// ABSOLUTE target clock; the stored/applied value stays the offset — the
// IGCL API only accepts offsets). baseClock = device.graphicsClockMHz
// (the Dashboard device card's max clock), captured at render, stable per
// session; null -> the toggle is hidden (no base to convert).
let freqMode: 'offset' | 'clock' = 'offset';
let baseClock: number | null = null;
// M4-B (user): the automatic waiver re-prompt + single retry counter — the
// driver can lose the waiver while settings.json still says accepted; the
// first apply then fails with waiver-not-set and re-prompts + retries once.
// Reset on every successful apply.
let waiverRetryCount = 0;
const cards = new Map<string, HTMLElement>();
const valueNodes = new Map<string, HTMLElement>();
const driverNodes = new Map<string, HTMLElement>();
// M4-B step-5 F2: the card's meta range line — refreshCard keeps it in sync
// with the mode's slider range (Clock mode would otherwise leave the
// OFFSET range caption under the absolute-clock slider).
const rangeNodes = new Map<string, HTMLElement>();
const chipNodes = new Map<string, HTMLElement>();
let applyBtn: HTMLButtonElement | null = null;
let applying = false;
// M4-D2 (§8): the Tuning page's sub-view — 'tuning' = the OC controls,
// 'fan' = the fan curve editor. Module-level (persists across re-renders —
// a caps-change re-render must not drop the fan view); default 'tuning';
// the #/fan redirect forces 'fan' via consumeFanViewRequest at render.
let view: 'tuning' | 'fan' = 'tuning';
let viewContainer: HTMLElement | null = null;

function resetPageState(state: DeviceState, caps: Capabilities) {
  values = {};
  applied = {};
  currentState = state;
  lastRenderedCaps = caps;
  renderCaps = caps;
  applying = false;
  freqMode = 'offset';
  baseClock = null;
  cards.clear();
  valueNodes.clear();
  driverNodes.clear();
  rangeNodes.clear();
  chipNodes.clear();
  applyBtn = null;
  viewContainer = null;
}

/** M3-C-G: hidden until the first apply of this control; green "Applied"
 *  while the value equals the last applied value; warn "Unapplied" once the
 *  value differs after applying. */
function refreshChip(key: string) {
  const chip = chipNodes.get(key);
  if (!chip) return;
  if (!(key in applied)) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const ok = values[key] === applied[key];
  chip.textContent = ok ? 'Applied' : 'Unapplied';
  chip.className = `chip oc-chip-status ${ok ? 'chip-ok' : 'chip-warn'}`;
}

/** M3-C-F: refresh ONE card in place from the current values + fresh state:
 *  slider, value readout, the "Driver:" readout, the chip. M4-B: the freq
 *  card in Clock mode slides/reads out the ABSOLUTE clock (base + offset).
 *  M4-B step-5 F1: the range derives from the CLAMPED exposure (same helper
 *  as buildCard) — the raw caps must never re-widen the slider after build
 *  (the M2C-A F3 guard). F2: the .oc-range meta line follows the mode. */
function refreshCard(key: string) {
  const caps = renderCaps;
  const range = cardSliderRange(caps, key);
  if (!range) return;
  const value = values[key];
  const clockMode = isFreqClockMode(key);
  const sliderRange = clockMode ? clockRangeFromOffsetRange(range, baseClock as number) : range;
  const displayValue = clockMode ? offsetToClock(value, baseClock as number) : value;
  const input = cards.get(key)?.querySelector<HTMLInputElement>(`input[type="range"]`);
  const fill = cards.get(key)?.querySelector<HTMLElement>('.oc-track-fill');
  const valueNode = valueNodes.get(key);
  const driverNode = driverNodes.get(key);
  const rangeNode = rangeNodes.get(key);
  // M4-B: the slider's min/max/step attributes follow the mode — Clock mode
  // slides over the absolute-clock range (the attrs are set at build time
  // from the offset range; the mode flip must move them in place).
  if (input) {
    input.min = String(sliderRange.min);
    input.max = String(sliderRange.max);
    input.step = String(sliderRange.step);
    input.value = String(snapToRange(displayValue, sliderRange));
  }
  if (fill) fill.style.width = `${normalizedPosition(displayValue, sliderRange) * 100}%`;
  if (valueNode) valueNode.textContent = formatValue(displayValue, sliderRange.units);
  // M4-B step-5 F2: the meta range caption describes the CURRENT slider —
  // in Clock mode it must read the absolute-clock range, never the stale
  // offset range the card was built with.
  if (rangeNode) rangeNode.textContent = `${sliderRange.min} – ${sliderRange.max} ${sliderRange.units} · step ${sliderRange.step}`;
  // The "Driver:" readout always reflects the FRESH state — never built once
  // at render (the stale part that forced the leave-and-return dance). In
  // Clock mode it shows the absolute clock of the driver's current offset.
  if (driverNode) {
    const raw = currentState?.[key as keyof DeviceState];
    const driverValue = clockMode && typeof raw === 'number'
      ? offsetToClock(raw, baseClock as number)
      : raw;
    driverNode.textContent = formatDriverValue(typeof driverValue === 'number' ? driverValue : null, sliderRange);
  }
  refreshChip(key);
  updateFloating();
}

// M4-B: the freq card is in Clock mode (and a base clock is available).
function isFreqClockMode(key: string): boolean {
  return key === 'gpuFreqOffsetMhz' && freqMode === 'clock' && baseClock !== null;
}

function updateFloating() {
  if (!applyBtn) return;
  if (applying) return;
  applyBtn.hidden = !computeDirtyVsApplied(buildScalarSettings(values), currentState as DeviceState, applied);
}

export const tuningPage: Page = {
  id: 'tuning',

  render(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    const caps = s.caps;
    const state = s.state;
    clear(container);
    resetPageState(state as DeviceState, caps as Capabilities);

    // M4-D2 (§8): the old #/fan hash arrives with the fan view requested.
    if (consumeFanViewRequest()) view = 'fan';

    // The deviceId-null guard runs FIRST: on the no-Intel path both
    // deviceId and caps/state are null, and the honest answer is 'No GPU
    // available.' — never a perpetual 'Loading device capabilities…' (the
    // caps fetch can never land on that path). When a deviceId IS set the
    // caps guard still covers the transient boot window.
    if (s.deviceId === null) {
      container.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
      return;
    }
    if (!caps || !state) {
      container.append(el('p', { class: 'page-subtitle', text: 'Loading device capabilities…' }));
      return;
    }

    // M4-B: the absolute-clock base = the device's default max clock (the
    // same value the Dashboard device card shows), captured at render.
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    baseClock = device?.graphicsClockMHz && Number.isFinite(device.graphicsClockMHz) && device.graphicsClockMHz > 0
      ? device.graphicsClockMHz
      : null;

    const controls = supportedScalars(caps);
    // Slider state: start from the driver's current values, snapped to step.
    for (const key of controls) {
      const cur = state[key as keyof DeviceState];
      values[key] = snapToRange(typeof cur === 'number' ? cur : caps.ranges[key].default, caps.ranges[key]);
    }

    // --- floating Apply (M2b-B): bottom-left, dirty-only -------------------
    // F3 instant apply (M2C-B): one attempt, immediate result; the button is
    // just a trigger (a reentry guard swallows a double-click mid-apply).
    // M2C-C: the button shows a transient "Applying…" state while an apply
    // is pending (e.g. waiting on the UAC prompt) — disabled, no retry UI.
    applyBtn = el('button', { class: 'btn btn-primary floating-apply', text: APPLY_BTN_TEXT });
    applyBtn.addEventListener('click', () => {
      if (applying) return;
      void apply(ctx);
    });
    const setBusy = (busy: boolean) => {
      applying = busy;
      if (!applyBtn) return;
      applyBtn.disabled = busy;
      applyBtn.textContent = busy ? APPLY_BTN_BUSY_TEXT : APPLY_BTN_TEXT;
    };

    const buildCard = (key: string): HTMLElement => {
      // F3 PT clamp (M2C-A) / M2C-C extended ranges: the temp-limit range is
      // pinned to 90 C max unless the device reports extended ranges (then
      // the backend already says 115 C); the power slider is pinned to 252 W
      // unless extended — sliders never exceed what the current mode allows.
      // M3-C-E: in stock mode the backend caps carry no extendedRanges, so
      // the sliders stay within the standard limits by construction.
      // M4-B step-5 F1: derived via cardSliderRange — the SAME helper the
      // refresh path uses, so the clamp survives every in-place refresh.
      const range: RangeInfo = cardSliderRange(caps, key) as RangeInfo;
      // M4-B: the freq card in Clock mode slides over the ABSOLUTE clock
      // range (offset range translated by baseClock).
      const clockMode = isFreqClockMode(key);
      const sliderRange = clockMode ? clockRangeFromOffsetRange(range, baseClock as number) : range;
      const rawDriver = state[key as keyof DeviceState];
      const driverRaw = typeof rawDriver === 'number' ? rawDriver : null;
      const driverValue = clockMode && driverRaw !== null ? offsetToClock(driverRaw, baseClock as number) : driverRaw;
      const driverText = formatDriverValue(driverValue, sliderRange);
      const offGrid = isOffGrid(driverValue, sliderRange);

      const card = el('section', { class: 'card oc-card', dataset: { control: key } }, [
        el('div', { class: 'oc-card-head' }, [
          el('h2', { class: 'card-title', text: CONTROL_LABELS[key] ?? key }),
          el('span', { class: 'oc-driver', title: offGrid ? 'Off-grid value reported by the driver (snap applies on move)' : undefined },
            [el('span', { class: 'oc-driver-label', text: 'Driver: ' }), el('span', { class: 'oc-driver-value', text: driverText })]),
        ]),
        el('div', { class: 'oc-slider-row' }, [
          el('div', { class: 'oc-slider' }, [
            el('div', { class: 'oc-track-fill' }),
            el('input', {
              type: 'range',
              min: sliderRange.min,
              max: sliderRange.max,
              step: sliderRange.step,
              value: snapToRange(clockMode ? offsetToClock(values[key], baseClock as number) : values[key], sliderRange),
              oninput: (e: Event) => {
                const raw = Number((e.target as HTMLInputElement).value);
                // M4-B: in Clock mode the slider yields an ABSOLUTE clock —
                // convert back to the offset the apply path stores. The mode
                // is read LIVE (isFreqClockMode), never the build-time
                // closure: a mode flip must change the conversion too.
                values[key] = isFreqClockMode(key)
                  ? clockToOffset(snapToRange(raw, clockRangeFromOffsetRange(range, baseClock as number)), baseClock as number)
                  : snapToRange(raw, range);
                refreshCard(key);
              },
            }),
          ]),
          el('div', { class: 'oc-value', text: formatValue(clockMode ? offsetToClock(values[key], baseClock as number) : values[key], sliderRange.units) }),
        ]),
        // M4-B: the Offset/Clock segmented toggle (Wattman-style) — the
        // GPU-frequency-offset card ONLY, hidden when no base clock exists.
        ...(key === 'gpuFreqOffsetMhz' && baseClock !== null
          ? [el('div', { class: 'oc-freq-mode-row' }, [
              el('div', { class: 'oc-mode-toggle oc-freq-mode-toggle', role: 'group' }, [
                el('button', {
                  class: `oc-mode-btn oc-freq-mode-btn${freqMode === 'offset' ? ' active' : ''}`,
                  dataset: { mode: 'offset' },
                  text: 'Offset',
                  title: 'Set the frequency as an offset from the base clock',
                  onClick: () => setFreqMode('offset'),
                }),
                el('button', {
                  class: `oc-mode-btn oc-freq-mode-btn${freqMode === 'clock' ? ' active' : ''}`,
                  dataset: { mode: 'clock' },
                  text: 'Clock',
                  title: `Set the absolute target clock (base ${baseClock} MHz + offset)`,
                  onClick: () => setFreqMode('clock'),
                }),
              ]),
            ])]
          : []),
        // M3-C-G: the preset chips are gone — the meta row is the range line
        // only (single line; the freed space makes the tab more compact).
        el('div', { class: 'oc-meta' }, [
          el('span', { class: 'oc-range', text: `${sliderRange.min} – ${sliderRange.max} ${sliderRange.units} · step ${sliderRange.step}` }),
        ]),
        el('div', { class: 'oc-card-actions' }, [
          el('span', { class: 'chip oc-chip-status', hidden: true }),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Reset to default',
            onClick: () => {
              // M4-B: in Clock mode the default is the ABSOLUTE default
              // (base + range.default) — converts back to the same offset.
              // Mode read LIVE (a flip must move the reset too).
              if (isFreqClockMode(key)) {
                const clockRange = clockRangeFromOffsetRange(range, baseClock as number);
                values[key] = clockToOffset(snapToRange(clockRange.default, clockRange), baseClock as number);
              } else {
                values[key] = snapToRange(range.default, range);
              }
              refreshCard(key);
            },
          }),
        ]),
      ]);

      valueNodes.set(key, card.querySelector<HTMLElement>('.oc-value') as HTMLElement);
      driverNodes.set(key, card.querySelector<HTMLElement>('.oc-driver-value') as HTMLElement);
      rangeNodes.set(key, card.querySelector<HTMLElement>('.oc-range') as HTMLElement);
      chipNodes.set(key, card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
      cards.set(key, card);
      refreshCard(key);
      return card;
    };

    // M4-B: flip the freq card between Offset and Clock presentation. The
    // stored value stays an offset in both modes — only the slider range +
    // readouts translate (refreshCard handles the rest).
    const setFreqMode = (mode: 'offset' | 'clock') => {
      if (freqMode === mode) return;
      freqMode = mode;
      refreshCard('gpuFreqOffsetMhz');
      const toggle = cards.get('gpuFreqOffsetMhz')?.querySelector<HTMLElement>('.oc-freq-mode-toggle');
      toggle?.querySelectorAll<HTMLButtonElement>('.oc-freq-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === freqMode);
      });
    };

    // M4-B: the gpuLock editor card (Advanced section) — Voltage (V) +
    // Frequency (MHz) inputs + Apply/Reset, gated on caps.controls.gpuLock.
    // The backend apply path already exists (igcl-backend.applyLock / mock
    // parity / the ipc-core clamp) — this ships the UI. The clamp bounds
    // (GPU_LOCK_VOLT_MAX_V 1.5 V, 0 = "don't touch voltage") are enforced
    // in main, so the inputs mirror them as friendly hints, never a gate.
    const buildLockEditor = (ctx: PageContext): HTMLElement => {
      const lock = (state.gpuLock && typeof state.gpuLock === 'object'
        ? state.gpuLock
        : { voltageV: 0, freqMhz: 0 }) as { voltageV: number; freqMhz: number };
      const currentLine = el('div', { class: 'gpu-lock-current' });
      const refreshCurrent = (pair: { voltageV: number; freqMhz: number } | null | undefined) => {
        currentLine.textContent = pair && (pair.voltageV !== 0 || pair.freqMhz !== 0)
          ? `Applied: ${pair.voltageV} V / ${pair.freqMhz} MHz`
          : 'Applied: Dynamic (unlocked)';
      };
      refreshCurrent(lock);

      const voltageInput = el('input', {
        type: 'number',
        min: '0',
        max: '1.5',
        step: '0.001',
        value: lock.voltageV,
        dataset: { lockField: 'voltageV' },
        title: 'Absolute lock voltage (V). 0 = don\'t touch voltage (the driver keeps the stock voltage at the locked frequency).',
      });
      const freqInput = el('input', {
        type: 'number',
        min: '0',
        max: '5000',
        step: '1',
        value: lock.freqMhz,
        dataset: { lockField: 'freqMhz' },
        title: 'Absolute lock frequency (MHz).',
      });

      const applyLock = async () => {
        const live = ctx.store.get();
        const deviceId = live.deviceId;
        if (deviceId === null || !caps) return;
        // M4-B step-5 F3: parse + validate FIRST — empty/whitespace fields
        // are rejected before conversion (Number('') === 0 would silently
        // apply the legal 0 V / 0 MHz UNLOCK pair); non-numeric fields too.
        const parsed = parseGpuLockInput(voltageInput.value, freqInput.value);
        if (!parsed.ok) {
          toast('error', 'GPU lock', 'Voltage and frequency must be numbers.');
          return;
        }
        const { voltageV, freqMhz } = parsed.pair;
        // Same waiver gate as every apply path (the boot/row acceptance is
        // read LIVE from the store — never the render-closure caps).
        const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, caps.deviceName || 'this GPU');
        if (decision === 'cancelled') {
          toast('info', 'Apply cancelled', 'The warranty waiver must be accepted before overclocking.');
          return;
        }
        {
          const cur = ctx.store.get();
          if (cur.caps && cur.caps.waiverAccepted !== true) {
            ctx.store.set({ caps: { ...cur.caps, waiverAccepted: true } });
          }
        }
        try {
          const { result, state: fresh } = await api.applySettings(deviceId, { gpuLock: { voltageV, freqMhz } });
          if (fresh) {
            currentState = fresh;
            ctx.store.set({ state: fresh });
          }
          const per = result.perControl.gpuLock;
          if (per?.ok) {
            // M4-B step-5 F4: report the pair the DRIVER received — the
            // read-back pair when the fresh envelope carried one (main
            // clamped the typed values; the toast must agree with the
            // 'Applied:' line), else the locally clamped pair (same bounds
            // as main's clampGpuLock) so a null envelope never re-prints
            // out-of-bounds typed values.
            const appliedPair = gpuLockToastPair({ voltageV, freqMhz }, fresh?.gpuLock);
            toast('success', 'GPU lock applied', `${appliedPair.voltageV} V / ${appliedPair.freqMhz} MHz`);
            ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
          } else {
            toast('error', 'GPU lock failed', per?.message ?? errorMessage(per?.errorCode, 'gpuLock'));
            const freshCaps = await api.getCapabilities(deviceId);
            ctx.store.set({ caps: freshCaps });
          }
          ctx.store.set({
            lastApply: {
              ok: result.ok,
              at: Date.now(),
              detail: result.ok ? 'GPU lock applied' : (per?.message ?? 'GPU lock failed'),
            },
          });
          // M4-B step-4 F4: only refresh the "Applied:" line on a NON-NULL
          // fresh envelope — a refused/null-state apply must keep the
          // previous line (the driver state is unknown, never "unlocked").
          if (fresh) {
            refreshCurrent(fresh.gpuLock ?? null);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.store.set({ lastApply: { ok: false, at: Date.now(), detail: msg } });
          toast('error', 'GPU lock failed', msg);
        }
      };

      return el('div', { class: 'card gpu-lock-editor' }, [
        el('h3', { class: 'card-title', text: 'GPU lock' }),
        el('p', {
          class: 'card-note',
          text: 'Lock the GPU to a voltage/frequency pair. Voltage 0 means "keep the stock voltage at the locked frequency"; the pair 0 / 0 unlocks (dynamic).',
        }),
        el('div', { class: 'gpu-lock-fields' }, [
          el('label', { class: 'gpu-lock-field' }, [
            el('span', { class: 'gpu-lock-label', text: 'Voltage (V)' }),
            voltageInput,
          ]),
          el('label', { class: 'gpu-lock-field' }, [
            el('span', { class: 'gpu-lock-label', text: 'Frequency (MHz)' }),
            freqInput,
          ]),
        ]),
        el('div', { class: 'gpu-lock-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', text: 'Apply', onClick: () => void applyLock() }),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Reset',
            title: 'Reset the editor to the default unlock pair (0 V / 0 MHz)',
            onClick: () => {
              voltageInput.value = '0';
              freqInput.value = '0';
              // M4-B step-4 F3: Reset means "the default unlock pair" — the
              // line must agree with the inputs (0/0), never snap back to
              // the render-time closure lock.
              refreshCurrent({ voltageV: 0, freqMhz: 0 });
            },
          }),
        ]),
        currentLine,
      ]);
    };

    // --- M3-C-E: the OC-mode segmented toggle (near the top) ---------------
    const setMode = async (mode: OcMode): Promise<void> => {
      const live = ctx.store.get();
      if (mode === live.ocMode) return;
      if (mode === 'advanced') {
        // M3-C-D disclaimer: enabling Advanced warns about beyond-standard
        // limits, card/driver/PSU dependence, and the BiFrost 300 W profile.
        // M4-B (user): the warning shows ONLY on the first Stock->Advanced
        // toggle — the acceptance is persisted (advanced-mode-accepted-set),
        // so a re-boot never re-asks. Only the toggle click reaches this
        // code path; nothing else can enable the mode.
        let accepted = false;
        try {
          ({ accepted } = await api.advancedModeAcceptedGet());
        } catch {
          // A read failure must not dead-click the toggle: over-warn (show
          // the disclaimer) rather than silently doing nothing.
          accepted = false;
        }
        if (accepted !== true) {
          const confirmed = await showAdvancedModeConfirm(caps.deviceName || 'this GPU');
          if (!confirmed) return;
          try {
            await api.advancedModeAcceptedSet();
          } catch (err) {
            // The warning was shown; a persist failure must not block the
            // mode change — the dialog simply re-appears on the next toggle.
            toast('warn', 'Advanced OC Mode', 'The confirmation could not be saved — it will be asked again.');
          }
        }
      }
      try {
        await api.ocModeSet(mode);
        // M3-C-E: mode change invalidated the backend caps cache — re-fetch
        // (extended ranges appear/disappear) and let the store subscriber's
        // onUpdate full-re-render the page via ocCapsChanged.
        const freshCaps = await api.getCapabilities(s.deviceId as number);
        ctx.store.set({ ocMode: mode, caps: freshCaps });
        if (mode === 'advanced') {
          toast('info', 'Advanced OC Mode enabled', 'Extended power/temperature limits are now available.');
        } else {
          toast('info', 'Advanced OC Mode disabled', 'Only Intel-standard limits are available.');
        }
      } catch (err) {
        toast('error', 'OC mode could not be changed', err instanceof Error ? err.message : String(err));
      }
    };
    // M4-B (user): the label sits ABOVE the segmented control as a caption —
    // a label inside the pill made the whole control read as a single
    // "OC mode" button. The pill now holds only the two choices.
    // M4-D2 (§8): the row is a FLEX ROW — LEFT the Stock/Advanced pill
    // (unchanged), RIGHT the "Tuning | Fan Curve" view pill at the SAME
    // height (both columns are identical label-over-toggle stacks; the
    // ui-verify pin asserts the pills' getBoundingClientRect tops are equal).
    // M4-F: the compact GPU selector rides the oc-mode ROW (a third
    // label-over-select column, same height pattern as the pills). Hidden
    // with <= 1 device (the honest single-device degradation). The switch
    // re-renders this page (selectDevice) — the sliders then derive from
    // the new device's caps/state.
    const deviceSelect = buildDeviceSelect(ctx.store, (id) => void selectDevice(id));
    const modeRow = el('div', { class: 'oc-mode-row' }, [
      el('div', { class: 'oc-mode-col' }, [
        el('span', { class: 'oc-mode-label', text: 'OC mode' }),
        el('div', { class: 'oc-mode-toggle', role: 'group', 'aria-label': 'OC mode' }, [
          el('button', {
            class: `oc-mode-btn${s.ocMode === 'stock' ? ' active' : ''}`,
            text: 'Stock',
            onClick: () => void setMode('stock'),
          }),
          el('button', {
            class: `oc-mode-btn${s.ocMode === 'advanced' ? ' active' : ''}`,
            text: 'Advanced',
            onClick: () => void setMode('advanced'),
          }),
        ]),
      ]),
      el('div', { class: 'oc-mode-col' }, [
        el('span', { class: 'oc-mode-label', text: 'View' }),
        el('div', { class: 'oc-mode-toggle tuning-view-toggle', role: 'group', 'aria-label': 'Tuning view' }, [
          el('button', {
            class: `oc-mode-btn tuning-view-btn${view === 'tuning' ? ' active' : ''}`,
            dataset: { view: 'tuning' },
            text: 'Tuning',
            onClick: () => setView('tuning'),
          }),
          el('button', {
            class: `oc-mode-btn tuning-view-btn${view === 'fan' ? ' active' : ''}`,
            dataset: { view: 'fan' },
            text: 'Fan Curve',
            onClick: () => setView('fan'),
          }),
        ]),
      ]),
      ...(deviceSelect ? [el('div', { class: 'oc-mode-col device-select-col' }, [
        el('span', { class: 'oc-mode-label', text: 'GPU' }),
        deviceSelect,
      ])] : []),
    ]);

    // M4-D2 (§8): the view switch re-renders ONLY the sub-view container —
    // the OC slider state (values/applied — module-level) survives the
    // round trip and the fan editor's own module state survives too.
    const setView = (v: 'tuning' | 'fan'): void => {
      if (view === v) return;
      view = v;
      renderView();
      modeRow.querySelectorAll<HTMLButtonElement>('.tuning-view-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === view);
      });
    };
    const renderView = (): void => {
      if (!viewContainer) return;
      clear(viewContainer);
      if (view === 'fan') {
        renderFanEditor(viewContainer, ctx);
        return;
      }
      const body: Array<Node | string> = [
        controls.length > 0
          ? el('div', { class: 'card-stack oc-stack' }, controls.map(buildCard))
          : el('div', { class: 'card', text: 'No overclocking controls are available on this device.' }),

        el('details', { class: 'card advanced-card' }, [
          el('summary', { class: 'card-title advanced-summary', text: 'Advanced (expert controls)' }),
          el('div', { class: 'card-body' }, [
            // M4-D (user): ONLY supported rows render — the unsupported ones
            // are removed entirely (no "Unsupported on this GPU" rows). The
            // filter keys on row.control (the IGCL-keyed caps.controls key —
            // M4-D review F1); the state read below keeps the CANONICAL
            // row.key.
            ...EXPERT_CONTROLS
              .filter(({ control }) => caps.controls[control] === true)
              .map(({ key, label, note }) => {
                const cur = state[key as keyof DeviceState];
                const current = key === 'gpuLock'
                  ? (cur && (cur as { voltageV: number }).voltageV !== 0 ? `${(cur as { voltageV: number }).voltageV} V / ${(cur as { freqMhz: number }).freqMhz} MHz` : 'Dynamic (unlocked)')
                  : cur === null || cur === undefined ? '—' : JSON.stringify(cur);
                return el('div', { class: 'expert-row' }, [
                  el('span', { class: 'expert-label', text: label }),
                  el('span', { class: 'expert-value', text: String(current) }),
                  // M4-B: gpuLock has an editor in this section ("Editing
                  // available"); vfCurve + VRAM offsets have no apply path yet
                  // — the honest M5 note.
                  el('span', { class: 'expert-status', text: note }),
                ]);
              }),
            // M4-B: the gpuLock editor — a card in the Advanced section, gated
            // on caps.controls.gpuLock (the backend apply paths already exist).
            ...(caps.controls.gpuLock === true ? [buildLockEditor(ctx)] : []),
          ]),
        ]),

        applyBtn as Node,
      ];
      viewContainer.append(...body);
      updateFloating();
    };

    const apply = async (ctx: PageContext) => {
      const live = ctx.store.get();
      const deviceId = live.deviceId;
      if (deviceId === null || !caps) return;
      const settings = buildScalarSettings(values);
      if (!validateSettingsPayload(settings)) {
        toast('error', 'Apply aborted', 'The settings payload failed validation — this is a bug.');
        return;
      }
      const deviceName = caps.deviceName || 'this GPU';
      // M3-C review F4: the waiver gate reads the LIVE store's caps, never
      // the render-closure caps — an in-session acceptance (this session's
      // waiver-accept) must not re-prompt on the next apply. The closure
      // caps lag until a re-render (the post-apply store update is a
      // content-only caps change that does not re-render the page).
      const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, deviceName);
      if (decision === 'cancelled') {
        toast('info', 'Apply cancelled', 'The warranty waiver must be accepted before overclocking.');
        return;
      }
      // M4-A: an in-page acceptance patches the store caps IMMEDIATELY (not
      // only post-apply) — the dashboard's waiver health row flips green on
      // the next caps-change re-render, and stays green even if the apply
      // below then fails/throws.
      {
        const cur = ctx.store.get();
        if (cur.caps && cur.caps.waiverAccepted !== true) {
          ctx.store.set({ caps: { ...cur.caps, waiverAccepted: true } });
        }
      }
      // M3-C-D: no per-apply extended-range confirm — the mode gate in main
      // is the honesty (stock refuses, advanced already warned at enable).
      // M2C-C: a non-elevated product app delegates the apply to the
      // elevated self-worker (one UAC prompt) — explain BEFORE the prompt.
      // M4-D2: the packaged EXE is asInvoker now — the workerApply toast
      // applies (the worker still spawns elevated when the user approves).
      if (ctx.store.get().workerApply && !ctx.store.get().elevated) {
        toast('info', 'Administrator approval needed', ELEVATION_TOAST_TEXT);
      }
      try {
        // M2b-B no-op suppression compares against the PRE-apply state: a
        // control whose value already equals the driver read-back stays
        // silent on success.
        const before = currentState;
        setBusy(true);
        const { result, state: fresh } = await api.applySettings(deviceId, settings);
        // M1 risk note: IGS may change OC state — refresh after every apply.
        // M3-C-F: EVERY card refreshes from the fresh state in place (the
        // "Driver:" readout, the slider, the chips) — no navigation needed.
        // M3-C review F2: only store a NON-NULL fresh state — a refusal
        // envelope's null state must never null the store's device state
        // (the page would render 'Loading device capabilities…' forever and
        // updateFloating would throw on the null state).
        if (fresh) {
          currentState = fresh;
          ctx.store.set({ state: fresh });
        }
        // M3-A: record the outcome for the dashboard "OC Status" health row
        // (honest: ok with what changed / failed with the first error).
        {
          const changed = Object.entries(result.perControl)
            .filter(([k, per]) => per.ok && !isNoopApply(k, settings, before as DeviceState))
            .map(([k]) => CONTROL_LABELS[k] ?? k);
          const failed = Object.entries(result.perControl)
            .filter(([, per]) => !per.ok)
            .map(([k, per]) => `${CONTROL_LABELS[k] ?? k}: ${per.message ?? per.errorCode ?? 'failed'}`)
            .join('; ');
          ctx.store.set({
            lastApply: {
              ok: result.ok,
              at: Date.now(),
              detail: result.ok
                ? (changed.length > 0 ? `${changed.join(', ')} applied` : 'OC apply ok (nothing changed)')
                : failed,
            },
          });
        }
        for (const [key, per] of Object.entries(result.perControl)) {
          const range = caps.ranges[key];
          if (!per.ok) {
            // F3 instant: refusals carry the composed actionable message;
            // hard errors keep the errorCode mapping.
            toast('error', `${CONTROL_LABELS[key] ?? key} failed`, per.message ?? errorMessage(per.errorCode, key));
          } else {
            // B5(a): a control that applied becomes the APPLIED reference —
            // its chip clears and the button hides even while the driver
            // read-back lags. (b) The toast still needs a REAL change vs
            // the pre-apply read-back.
            const wanted = settings[key as keyof typeof settings];
            if (typeof wanted === 'number') applied[key] = wanted;
            if (!isNoopApply(key, settings, before as DeviceState)) {
              toast('success', `${CONTROL_LABELS[key] ?? key} applied`, typeof wanted === 'number' && range ? formatValue(wanted, range.units) : '');
            }
            // per.ok && no-op -> silent (M2b-B): nothing changed, no toast.
          }
        }
        for (const key of controls) refreshCard(key);
        updateFloating();
        if (!result.ok) {
          // The waiver may have been lost on the device (e.g. driver reset).
          const freshCaps = await api.getCapabilities(deviceId);
          ctx.store.set({ caps: freshCaps });
          // M4-B (user): a waiver-not-set failure must not dead-end the
          // first apply with a confusing error — re-prompt the waiver dialog
          // AUTOMATICALLY (the store flag was just refreshed, so the dialog
          // shows) and retry ONCE. Never a loop; on success the counter
          // resets, so a later driver-side loss still gets its own retry.
          if (waiverRetryCount === 0
            && Object.values(result.perControl).some((p) => p?.errorCode === 'waiver-not-set')) {
            waiverRetryCount += 1;
            const live2 = ctx.store.get();
            const decision = await ensureWaiver(deviceId, live2.caps?.waiverAccepted === true, deviceName);
            if (decision === 'accepted') {
              // The store caps flag must be patched BEFORE the retry — the
              // retry re-enters the pre-apply waiver gate, which reads the
              // store flag; without the patch it would re-show the dialog
              // (the user just accepted — no second prompt).
              const cur3 = ctx.store.get();
              if (cur3.caps && cur3.caps.waiverAccepted !== true) {
                ctx.store.set({ caps: { ...cur3.caps, waiverAccepted: true } });
              }
              return apply(ctx);
            }
          }
        } else {
          waiverRetryCount = 0;
          ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
        }
      } catch (err) {
        // M2C-C: a declined/denied UAC prompt surfaces here with the honest
        // message (Apply requires administrator approval).
        const msg = err instanceof Error ? err.message : String(err);
        ctx.store.set({ lastApply: { ok: false, at: Date.now(), detail: msg } });
        if (msg.includes('administrator approval') || msg.includes('Administrator approval')) {
          toast('error', 'Apply requires administrator approval', msg);
        } else {
          toast('error', 'Apply failed', msg);
        }
      } finally {
        setBusy(false);
        updateFloating();
      }
    };

    // M4-D2 (§8): the page shell (title + subtitle + the pill row) renders
    // once; the ACTIVE VIEW's content lives in the view container below
    // (renderView builds it — the OC controls or the fan curve editor).
    viewContainer = el('div', { class: 'tuning-view' });
    container.append(
      el('h1', { class: 'page-title', text: 'Tuning' }),
      el('p', {
        class: 'page-subtitle',
        text: view === 'fan'
          ? 'Edit the fan curve or switch the fan mode. Changes apply on demand.'
          : (controls.length === 0
            ? 'This GPU does not expose any overclocking controls (locked or telemetry-only).'
            : 'Values are clamped to the range reported by this GPU. Changes apply on demand — nothing is applied until you press Apply.'),
      }),
      // M4-A (user correction): the waiver STATUS lives ONLY in the dashboard
      // GPU Health card — this page keeps no waiver UI beyond the apply-time
      // dialog gate (ensureWaiver above). The pill row renders for every
      // device: the Fan Curve view must stay reachable on no-OC devices.
      modeRow,
      viewContainer,
    );
    renderView();
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    // M3-C-F: a mode toggle / featureset swap changed the capability
    // SURFACE — full re-render (ranges/units change; the in-place refresh
    // cannot). Content comparison: the page's own post-apply caps re-set
    // ({ ...caps, waiverAccepted }) is NOT a surface change. The re-render
    // keeps the current sub-view (module-level `view`).
    if (ocCapsChanged(lastRenderedCaps, s.caps)) {
      tuningPage.render(container, ctx);
      return;
    }
    // M4-D2 (§8): the fan sub-view only tracks the RPM marker + readout on
    // telemetry ticks (the editor's own redraw handles its content — same
    // contract as the removed Fan page's onUpdate).
    if (view === 'fan') {
      updateFanReadout(container, ctx);
      return;
    }
    // M3-C-F: refresh the cards IN PLACE when the store's state slot changed
    // (an apply / profile load / external state change while this page is
    // current) — no full rebuild, no navigation.
    if (ocStateChanged(currentState, s.state)) {
      currentState = s.state;
      // Re-sync slider values from the driver for controls that were never
      // applied in this render (external state changes — profile load, tray
      // apply). Controls with an applied reference keep the user's position
      // (the B5 lag behavior: the chip reflects the applied value).
      for (const key of Object.keys(values)) {
        if (key in applied) continue;
        const raw = currentState?.[key as keyof DeviceState];
        // M4-B step-5 F1: the restore snap goes through the CLAMPED range
        // too — a raw (drift-wide) range would snap values[key] beyond the
        // exposed slider max and a subsequent apply would send it.
        const range = cardSliderRange(s.caps, key);
        if (typeof raw === 'number' && range) values[key] = snapToRange(raw, range);
      }
      for (const key of cards.keys()) refreshCard(key);
      updateFloating();
    }
  },
};
