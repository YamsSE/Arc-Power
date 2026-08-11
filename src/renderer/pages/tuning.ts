// Arc Power - Tuning page (M4-D2 §7/§8: renamed from Overclocking; the Fan
// page merged in as a sub-view). One card per supported control (slider,
// clamps, per-card reset), the M3-C-E OC-mode segmented toggle (Stock /
// Advanced with the beyond-Intel disclaimer), the Advanced disclosure for
// expert controls, and a floating Apply button anchored bottom-left that
// appears ONLY when a setting differs from the loaded driver state (dirty)
// and disappears when clean.
//
// M4-D2 (§8): the OC-mode row is a FLEX ROW - LEFT the Stock/Advanced pill
// (unchanged), RIGHT a second segmented pill "Tuning | Fan Curve" (same
// height, same styling) switching the page content between the tuning
// controls and the fan curve editor (pages/fan-editor.ts - the old Fan
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
// confirm on this page - in Advanced mode the mode-enable confirm already
// warned; in Stock mode the shared oc-mode gate refuses extended values
// with a toast (the slider max is pinned to the standard limit anyway).
//
// M3-C-F (dynamic refresh): after an apply EVERY card refreshes from the
// fresh device state - the "Driver:" readout (previously built once at
// render - the stale part that forced the leave-and-return dance), the
// slider, the chips. The page onUpdate refreshes the cards in place when
// the store's state slot changes (apply from any path / profile load /
// tray apply), and fully re-renders only when the capability surface
// changes (mode toggle / featureset swap). The refresh decision lives in
// the pure helpers ocStateChanged / ocCapsChanged (unit-tested).
//
// M3-C-G: the per-card Stock/Medium/Max preset chips are REMOVED (the pure
// computePresets stays for other consumers). M9: the chip state machine
// (pure/chip.ts) drives the per-control chip: 'none' (pristine - the hidden
// attribute, invisible via the CSS [hidden] fix), green "Applied" while the
// current value equals the last applied value, 'dirty' (the per-card Apply
// button - the old warn "Unapplied" chip is GONE). "Reset to default" stays.
//
// M4-B: (1) the offset ranges mirror into the negative half-plane (the UI
// math is range-driven - no special-casing); (2) the GPU-frequency-offset
// card gets the Offset/Clock segmented toggle (Wattman-style): Clock mode
// slides/reads out the ABSOLUTE clock (base = device.graphicsClockMHz,
// captured at render, stable per session) while the stored/applied value
// stays the offset (IGCL only accepts offsets - pure/clock.ts converts);
// (3) the gpuLock editor card ships in the Advanced section (Voltage +
// Frequency inputs + Apply/Reset, gated on caps.controls.gpuLock - the
// backend apply paths already existed); (4) expert-row texts are honest:
// gpuLock = "Editing available", vfCurve/VRAM rows = "M5" (no apply path).
//
// M4-D: the Advanced (expert) section renders ONLY rows whose
// control is SUPPORTED on the device (caps.controls[row.control] === true -
// the IGCL-keyed caps key, M4-D review F1) - the "Unsupported on this GPU"
// rows are REMOVED entirely (they said nothing the empty space could not);
// supported-but-M5 rows keep their honest note.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { consumeFanViewRequest } from '../router.ts';
import { api } from '../ipc.ts';
import { snapToRange, normalizedPosition, formatValue, formatDriverValue, isOffGrid } from '../pure/slider.ts';
import { clockToOffset, offsetToClock, clockRangeFromOffsetRange, boostToOffset, offsetToBoost, boostAvailable } from '../pure/clock.ts';
import { chipState } from '../pure/chip.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
import { buildScalarSettings, validateSettingsPayload, isNoopApply, computeDirtyVsApplied, isScalarDirtyVsApplied, ocStateChanged, ocCapsChanged, cardSliderRange, advancedUiVisible } from '../pure/settings.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { showAdvancedModeConfirm } from '../components/confirm-dialog.ts';
import { toast } from '../components/toast.ts';
import { buildDeviceSelect } from '../components/device-select.ts';
import { selectDevice } from '../app.ts';
import { renderFanEditor, updateFanReadout } from './fan-editor.ts';
// M4-H (B): the profiles page's prompt modal + id generator + the
// settingsFromState helper, reused by the "Save as Profile" card (the
// profiles page's own create/save flows stay).
import { newProfileId, promptModal, settingsFromState } from './profiles.ts';
import type { RangeInfo, Capabilities, DeviceState, OcMode, Profile, Settings } from '../types.ts';

// The pure refresh-signature helpers live in pure/settings.ts (unit-tested
// there); this page re-exports them so the import surface stays local.
export { ocStateChanged, ocCapsChanged } from '../pure/settings.ts';

// Display order only - support comes from caps.ranges, limits from the ranges.
const CONTROL_ORDER = ['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'powerLimitW', 'tempLimitC'];
// M4J (D): the EXPERT_CONTROLS row list is REMOVED with the M4-B expert
// section - the Advanced section now renders ONLY the VRAM clock editor on
// devices whose supportedControls carry vramFreqOffset (Battlemage); the
// vfCurve + vramVoltOffset rows are gone, and the gpuLock editor dies with
// the section on Alchemist (a770 has no vramFreqOffset - documented:
// profiles can still apply gpuLock via the state machinery).

export const APPLY_BTN_TEXT = 'Apply';
export const APPLY_BTN_BUSY_TEXT = 'Applying…';
// M2C-C first-apply elevation explanation: shown right before the UAC prompt
// (a short toast - the prompt itself is the OS's, this explains why).
export const ELEVATION_TOAST_TEXT = 'Administrator approval is needed to apply GPU settings.';
export const ELEVATION_CANCELED_TEXT = 'Apply requires administrator approval.';

// ---------------------------------------------------------------------------
// Page (per-render mutable state hoisted so onUpdate can refresh in place -
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
// ABSOLUTE target clock; the stored/applied value stays the offset - the
// IGCL API only accepts offsets). baseClock = device.graphicsClockMHz
// (the Dashboard device card's max clock), captured at render, stable per
// session; null -> the toggle is hidden (no base to convert).
let freqMode: 'offset' | 'clock' = 'offset';
let baseClock: number | null = null;
// M14: the freq card's IGS "Performance Boost" mode ('boost' = the slider
// is a PERCENT of the positive offset caps max - the A770: 100% = +300 MHz
// over the 2400 MHz reference; the stored/applied value stays the OFFSET).
// The [Performance Boost | Core Clock] toggle renders BEFORE the
// Offset|Clock row when the device exposes a positive max (boostAvailable
// - INDEPENDENT of baseClock: boost mode does not need one). ENTERING
// boost mode RESETS freqMode = 'offset' (the F2 hazard: a leftover 'clock'
// mode would route the boost slider's raw % through clockToOffset -> a
// wrong-value apply; the reset also makes the back-switch pin literal:
// the coreClock view shows the offset slider).
// M14 amendment: PERFORMANCE BOOST IS THE DEFAULT - resetPageState picks
// 'boost' whenever boostAvailable (the F3 gate: a non-positive caps max
// falls back to 'coreClock' - no boost possible); the declaration below is
// only the fallback value.
let freqControl: 'coreClock' | 'boost' = 'coreClock';
// M14: the boost slider's percent range (0..100, step 1 - the IGS shape;
// the offset conversion reads the caps range's positive max live).
const boostRange = (): RangeInfo => ({ min: 0, max: 100, step: 1, default: 0, units: '%' });
// M4-B: the automatic waiver re-prompt + single retry counter - the
// driver can lose the waiver while settings.json still says accepted; the
// first apply then fails with waiver-not-set and re-prompts + retries once.
// Reset on every successful apply.
let waiverRetryCount = 0;
const cards = new Map<string, HTMLElement>();
const valueNodes = new Map<string, HTMLElement>();
const driverNodes = new Map<string, HTMLElement>();
// M14 amendment: the freq card's TITLE element ref - the title is built at
// card-build time ('Performance Boost' in boost mode, the M4-B 'Core
// clock' name in coreClock mode) and FOLLOWS setFreqControl at runtime via
// this ref (the mode-following card title).
const titleNodes = new Map<string, HTMLElement>();
// M4-B step-5 F2: the card's meta range line - refreshCard keeps it in sync
// with the mode's slider range (Clock mode would otherwise leave the
// OFFSET range caption under the absolute-clock slider).
const rangeNodes = new Map<string, HTMLElement>();
const chipNodes = new Map<string, HTMLElement>();
// M9: the per-card Apply button (the chip state machine) - visible ONLY
// while that card is dirty; clicking it applies THAT card only.
const chipApplyNodes = new Map<string, HTMLButtonElement>();
let applyBtn: HTMLButtonElement | null = null;
let applying = false;
// M4-D2 (§8): the Tuning page's sub-view - 'tuning' = the OC controls,
// 'fan' = the fan curve editor. Module-level (persists across re-renders -
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
  // M14 amendment: PERFORMANCE BOOST IS THE DEFAULT - the page renders in
  // boost mode whenever the device exposes a positive offset max (the F3
  // gate - boostAvailable); only a non-positive max (no boost possible)
  // falls back to 'coreClock'. The boost default also RESETS freqMode to
  // 'offset' at render (the F2 discipline - the card never renders in a
  // mixed boost+clock state). The null-caps guard: on the no-Intel path
  // resetPageState runs with caps === null BEFORE the deviceId-null branch
  // renders its honest 'No GPU available.' (the boost gate must never
  // dereference a null caps - boostAvailable degrades on null/undefined).
  freqControl = boostAvailable(caps?.ranges?.gpuFreqOffsetMhz?.max) ? 'boost' : 'coreClock';
  baseClock = null;
  cards.clear();
  valueNodes.clear();
  driverNodes.clear();
  titleNodes.clear();
  rangeNodes.clear();
  chipNodes.clear();
  chipApplyNodes.clear();
  applyBtn = null;
  viewContainer = null;
}

/** M9: the shared chip state machine (pure/chip.ts) drives the per-card
 *  status + the per-card Apply button: 'none' (pristine or unsupported -
 *  the hidden attribute, invisible via the CSS [hidden] fix), 'applied'
 *  (the green chip), 'dirty' (the Apply button - the old "Unapplied" warn
 *  chip is GONE). Every rendered card is supported, so the machine's
 *  supported flag is always true here. */
function refreshChip(key: string) {
  const chip = chipNodes.get(key);
  if (!chip) return;
  const driverValue = currentState?.[key as keyof DeviceState];
  const state = chipState(key, values, applied, driverValue, true);
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

/** M3-C-F: refresh ONE card in place from the current values + fresh state:
 *  slider, value readout, the "Driver:" readout, the chip. M4-B: the freq
 *  card in Clock mode slides/reads out the ABSOLUTE clock (base + offset).
 *  M14: in boost mode it slides/reads out the PERCENT (offsetToBoost) -
 *  the boost branch takes precedence over the clock branch (a mode flip
 *  must move the conversion in place, and the two modes never coexist:
 *  entering boost resets freqMode to 'offset').
 *  M4-B step-5 F1: the range derives from the CLAMPED exposure (same helper
 *  as buildCard) - the raw caps must never re-widen the slider after build
 *  (the M2C-A F3 guard). F2: the .oc-range meta line follows the mode. */
function refreshCard(key: string) {
  const caps = renderCaps;
  const range = cardSliderRange(caps, key);
  if (!range) return;
  const value = values[key];
  const boostMode = isFreqBoostMode(key);
  const clockMode = isFreqClockMode(key);
  const sliderRange = boostMode
    ? boostRange()
    : (clockMode ? clockRangeFromOffsetRange(range, baseClock as number) : range);
  const displayValue = boostMode
    ? (offsetToBoost(value, range.max) ?? 0)
    : (clockMode ? offsetToClock(value, baseClock as number) : value);
  const input = cards.get(key)?.querySelector<HTMLInputElement>(`input[type="range"]`);
  const fill = cards.get(key)?.querySelector<HTMLElement>('.oc-track-fill');
  const valueNode = valueNodes.get(key);
  const driverNode = driverNodes.get(key);
  const rangeNode = rangeNodes.get(key);
  // M4-B: the slider's min/max/step attributes follow the mode - Clock mode
  // slides over the absolute-clock range, boost mode over the 0..100 %
  // range (the attrs are set at build time from the offset range; the mode
  // flip must move them in place).
  if (input) {
    input.min = String(sliderRange.min);
    input.max = String(sliderRange.max);
    input.step = String(sliderRange.step);
    input.value = String(snapToRange(displayValue, sliderRange));
  }
  if (fill) fill.style.width = `${normalizedPosition(displayValue, sliderRange) * 100}%`;
  if (valueNode) valueNode.textContent = formatValue(displayValue, sliderRange.units);
  // M4-B step-5 F2: the meta range caption describes the CURRENT slider -
  // in Clock mode it must read the absolute-clock range, never the stale
  // offset range the card was built with; M14: in boost mode the 0..100 %
  // range (the en-dash caption format is shared).
  if (rangeNode) rangeNode.textContent = `${sliderRange.min} – ${sliderRange.max} ${sliderRange.units} · step ${sliderRange.step}`;
  // The "Driver:" readout always reflects the FRESH state - never built once
  // at render (the stale part that forced the leave-and-return dance). In
  // Clock mode it shows the absolute clock of the driver's current offset;
  // in boost mode the percent (the negative half-plane clamps to 0 %).
  if (driverNode) {
    const raw = currentState?.[key as keyof DeviceState];
    const driverValue = boostMode && typeof raw === 'number'
      ? (offsetToBoost(raw, range.max) ?? 0)
      : (clockMode && typeof raw === 'number'
        ? offsetToClock(raw, baseClock as number)
        : raw);
    driverNode.textContent = formatDriverValue(typeof driverValue === 'number' ? driverValue : null, sliderRange);
  }
  refreshChip(key);
  updateFloating();
}

// M14: the freq card is in Performance Boost mode (the toggle only renders
// when a positive offset max exists - boostAvailable; the flag itself can
// never be set otherwise).
function isFreqBoostMode(key: string): boolean {
  return key === 'gpuFreqOffsetMhz' && freqControl === 'boost';
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
    // available.' - never a perpetual 'Loading device capabilities…' (the
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

    // M4J clarification (Alchemist scope): `advancedUi` keys the ADVANCED
    // SECTION only (caps.controls.vramFreqOffset - Battlemage yes, Alchemist
    // no). The OC-mode column (Stock/Advanced pill) renders on EVERY device
    // as in 1.0.3 - the mode + the advanced confirm + the extended ranges
    // work on Alchemist as before (only the bottom expert section is gone).
    const advancedUi = advancedUiVisible(caps);

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
    // is pending (e.g. waiting on the UAC prompt) - disabled, no retry UI.
    applyBtn = el('button', { class: 'btn btn-primary floating-apply', text: APPLY_BTN_TEXT });
    applyBtn.addEventListener('click', () => {
      if (applying) return;
      void apply(ctx);
    });
    const setBusy = (busy: boolean) => {
      applying = busy;
      // M9: the per-card Apply buttons share the busy state (disabled while
      // any apply is in flight - the same reentry guard as the floating one).
      for (const b of chipApplyNodes.values()) b.disabled = busy;
      if (!applyBtn) return;
      applyBtn.disabled = busy;
      applyBtn.textContent = busy ? APPLY_BTN_BUSY_TEXT : APPLY_BTN_TEXT;
    };

    const buildCard = (key: string): HTMLElement => {
      // F3 PT clamp (M2C-A) / M2C-C extended ranges: the temp-limit range is
      // pinned to 90 C max unless the device reports extended ranges (then
      // the backend already says 115 C); the power slider is pinned to 252 W
      // unless extended - sliders never exceed what the current mode allows.
      // M3-C-E: in stock mode the backend caps carry no extendedRanges, so
      // the sliders stay within the standard limits by construction.
      // M4-B step-5 F1: derived via cardSliderRange - the SAME helper the
      // refresh path uses, so the clamp survives every in-place refresh.
      const range: RangeInfo = cardSliderRange(caps, key) as RangeInfo;
      // M4-B: the freq card in Clock mode slides over the ABSOLUTE clock
      // range (offset range translated by baseClock). M14: in boost mode
      // over the 0..100 % percent range (the IGS shape - the offset
      // conversion reads the caps range's positive max live).
      const boostMode = isFreqBoostMode(key);
      const clockMode = isFreqClockMode(key);
      const sliderRange = boostMode
        ? boostRange()
        : (clockMode ? clockRangeFromOffsetRange(range, baseClock as number) : range);
      const rawDriver = state[key as keyof DeviceState];
      const driverRaw = typeof rawDriver === 'number' ? rawDriver : null;
      const driverValue = boostMode && driverRaw !== null
        ? (offsetToBoost(driverRaw, range.max) ?? 0)
        : (clockMode && driverRaw !== null ? offsetToClock(driverRaw, baseClock as number) : driverRaw);
      const driverText = formatDriverValue(driverValue, sliderRange);
      const offGrid = isOffGrid(driverValue, sliderRange);

      const card = el('section', { class: 'card oc-card', dataset: { control: key } }, [
        el('div', { class: 'oc-card-head' }, [
          // M14 amendment: the card title FOLLOWS the freqControl mode - in
          // boost mode the freq card reads 'Performance Boost', in
          // coreClock mode the M4-B 'Core clock' name (CONTROL_LABELS). The
          // title is built at card-build time + updated at runtime by
          // setFreqControl through the titleNodes ref.
          el('h2', { class: 'card-title', text: key === 'gpuFreqOffsetMhz' && boostMode ? 'Performance Boost' : (CONTROL_LABELS[key] ?? key) }),
          el('span', { class: 'oc-driver', title: offGrid ? 'Off-grid value reported by the driver (snap applies on move)' : undefined },
            [el('span', { class: 'oc-driver-label', text: 'Driver: ' }), el('span', { class: 'oc-driver-value', text: driverText })]),
        ]),
        // M14: the freq card's honest note (the vram-editor pattern - the
        // freq card had NO note before): the shared-knob/last-writer-wins
        // clause - the boost knob is the SAME driver control this card and
        // Intel Graphics Software (IGS) both write; the "Driver:" readout
        // shows reality. Renders in BOTH modes (the arbitration applies to
        // the whole shared knob, not one presentation).
        ...(key === 'gpuFreqOffsetMhz'
          ? [el('p', {
            class: 'card-note',
            text: 'The frequency offset is a single shared driver value - this app and Intel Graphics Software (IGS) both write it. The last apply wins; the Driver: readout always shows the current driver value.',
          })]
          : []),
        el('div', { class: 'oc-slider-row' }, [
          el('div', { class: 'oc-slider' }, [
            el('div', { class: 'oc-track-fill' }),
            el('input', {
              type: 'range',
              min: sliderRange.min,
              max: sliderRange.max,
              step: sliderRange.step,
              value: snapToRange(boostMode ? (offsetToBoost(values[key], range.max) ?? 0) : (clockMode ? offsetToClock(values[key], baseClock as number) : values[key]), sliderRange),
              oninput: (e: Event) => {
                const raw = Number((e.target as HTMLInputElement).value);
                // M4-B: in Clock mode the slider yields an ABSOLUTE clock -
                // convert back to the offset the apply path stores. M14:
                // the boost branch takes precedence - in boost mode the
                // slider yields a PERCENT, converted back to the offset
                // (boostToOffset). The mode is read LIVE (isFreqBoostMode /
                // isFreqClockMode), never the build-time closure: a mode
                // flip must change the conversion too.
                values[key] = isFreqBoostMode(key)
                  ? (boostToOffset(raw, range.max) ?? range.default)
                  : (isFreqClockMode(key)
                    ? clockToOffset(snapToRange(raw, clockRangeFromOffsetRange(range, baseClock as number)), baseClock as number)
                    : snapToRange(raw, range));
                refreshCard(key);
              },
            }),
          ]),
          el('div', { class: 'oc-value', text: formatValue(boostMode ? (offsetToBoost(values[key], range.max) ?? 0) : (clockMode ? offsetToClock(values[key], baseClock as number) : values[key]), sliderRange.units) }),
        ]),
        // M14: the Performance Boost | Core Clock toggle (the IGS pattern) -
        // the GPU-frequency-offset card ONLY, gated on a POSITIVE offset
        // max (boostAvailable - INDEPENDENT of baseClock: boost mode does
        // not need a base clock). Renders BEFORE the Offset|Clock row (the
        // user's exact layout: the new toggle IN FRONT of the existing one).
        ...(key === 'gpuFreqOffsetMhz' && boostAvailable(range.max)
          ? [el('div', { class: 'oc-boost-mode-row' }, [
              el('div', { class: 'oc-mode-toggle oc-boost-mode-toggle', role: 'group' }, [
                el('button', {
                  class: `oc-mode-btn oc-boost-mode-btn${freqControl === 'boost' ? ' active' : ''}`,
                  dataset: { boostMode: 'boost' },
                  text: 'Performance Boost',
                  title: 'Set the frequency as a percent of the maximum offset (like Intel Graphics Software)',
                  onClick: () => setFreqControl('boost'),
                }),
                el('button', {
                  class: `oc-mode-btn oc-boost-mode-btn${freqControl === 'coreClock' ? ' active' : ''}`,
                  dataset: { boostMode: 'coreClock' },
                  text: 'Core Clock',
                  title: 'Set the frequency as an offset from the base clock',
                  onClick: () => setFreqControl('coreClock'),
                }),
              ]),
            ])]
          : []),
        // M4-B: the Offset/Clock segmented toggle (Wattman-style) - the
        // GPU-frequency-offset card ONLY, hidden when no base clock exists.
        // M14: BUILT in both freqControl modes + HIDDEN at runtime when
        // freqControl === 'boost' (the user's clarification: the
        // Offset|Clock row renders ONLY in the 'coreClock' mode - the
        // hidden ATTRIBUTE is queried by the verify pins; the
        // .oc-freq-mode-row[hidden] CSS guard overrides the row's
        // display:flex - the M9 chip lesson).
        ...(key === 'gpuFreqOffsetMhz' && baseClock !== null
          ? [el('div', { class: 'oc-freq-mode-row', hidden: freqControl === 'boost' }, [
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
        // M3-C-G: the preset chips are gone - the meta row is the range line
        // only (single line; the freed space makes the tab more compact).
        el('div', { class: 'oc-meta' }, [
          el('span', { class: 'oc-range', text: `${sliderRange.min} – ${sliderRange.max} ${sliderRange.units} · step ${sliderRange.step}` }),
        ]),
        el('div', { class: 'oc-card-actions' }, [
          el('span', { class: 'chip oc-chip-status', hidden: true }),
          // M9: the per-card Apply button (the chip state machine) - a
          // small-chip button visible ONLY while this card is dirty; it
          // applies THAT card only (the single-control payload through the
          // same apply machinery - the waiver gate + the elevation toast +
          // the busy state included).
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
              // M4-B: in Clock mode the default is the ABSOLUTE default
              // (base + range.default) - converts back to the same offset.
              // M14: the boost branch takes precedence - in boost mode the
              // reset restores the OFFSET default (range.default; the
              // percent slider then reads its 0 % equivalent). Mode read
              // LIVE (a flip must move the reset too).
              if (isFreqBoostMode(key)) {
                values[key] = snapToRange(range.default, range);
              } else if (isFreqClockMode(key)) {
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
      // M14 amendment: the title ref - setFreqControl flips the freq card's
      // title in place through it (the mode-following card title).
      titleNodes.set(key, card.querySelector<HTMLElement>('.card-title') as HTMLElement);
      rangeNodes.set(key, card.querySelector<HTMLElement>('.oc-range') as HTMLElement);
      chipNodes.set(key, card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
      chipApplyNodes.set(key, card.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
      cards.set(key, card);
      refreshCard(key);
      return card;
    };

    // M4-B: flip the freq card between Offset and Clock presentation. The
    // stored value stays an offset in both modes - only the slider range +
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

    // M14: flip the freq card between Core Clock and Performance Boost
    // presentation. The stored value stays an OFFSET in both modes - only
    // the slider range + readouts translate (refreshCard handles the rest).
    // THE F2 HAZARD: entering boost mode RESETS freqMode = 'offset' - a
    // leftover 'clock' mode would route the boost slider's raw % through
    // clockToOffset -> a wrong-value apply; the reset also makes the
    // back-switch pin literal (the coreClock view shows the offset slider
    // at the SAME stored value). The Offset|Clock row is hidden by the
    // hidden ATTRIBUTE while boost mode is active.
    // M14 amendment: the card TITLE follows the mode at runtime - the
    // title element is built at card-build time ('Performance Boost' when
    // the page renders in the boost default; 'Core clock' via
    // CONTROL_LABELS) and flipped in place through the titleNodes ref.
    const setFreqControl = (mode: 'coreClock' | 'boost') => {
      if (freqControl === mode) return;
      freqControl = mode;
      if (mode === 'boost') freqMode = 'offset';
      refreshCard('gpuFreqOffsetMhz');
      const toggle = cards.get('gpuFreqOffsetMhz')?.querySelector<HTMLElement>('.oc-boost-mode-toggle');
      toggle?.querySelectorAll<HTMLButtonElement>('.oc-boost-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.boostMode === freqControl);
      });
      const freqRow = cards.get('gpuFreqOffsetMhz')?.querySelector<HTMLElement>('.oc-freq-mode-row');
      if (freqRow) freqRow.hidden = freqControl === 'boost';
      const title = titleNodes.get('gpuFreqOffsetMhz');
      if (title) title.textContent = mode === 'boost' ? 'Performance Boost' : (CONTROL_LABELS['gpuFreqOffsetMhz'] ?? 'Core clock');
    };

    // M4J (D): the VRAM clock editor card (Advanced section - Battlemage
    // ONLY: the section renders when caps.controls.vramFreqOffset is true).
    // A slider + Apply + read-back over caps.ranges.vramFreqOffsetGts - the
    // REAL apply path (igcl-backend applyScalar('vramFreqOffset') ->
    // ctlOverclockVramMemSpeedLimitSetV2, read back via GetV2; the mock
    // apply/read-back parity) - editor-only work: the backend surface
    // already existed. The M4-B gpuLock editor is REMOVED (the section dies
    // on Alchemist - documented: profiles can still apply gpuLock via the
    // state machinery).
    const buildVramEditor = (ctx: PageContext): HTMLElement => {
      const range = caps.ranges.vramFreqOffsetGts as RangeInfo;
      const vramValue = (() => {
        const cur = currentState?.vramFreqOffsetGts;
        return typeof cur === 'number' && Number.isFinite(cur) ? snapToRange(cur, range) : range.default;
      })();
      let vramApplied = vramValue;
      const slider = el('input', {
        type: 'range',
        min: range.min,
        max: range.max,
        step: range.step,
        value: vramValue,
        dataset: { vramEditor: 'slider' },
      });
      const readout = el('span', { class: 'vram-editor-value', text: formatValue(vramValue, range.units) });
      const driverLine = el('span', { class: 'vram-editor-driver' });
      const refreshDriver = () => {
        const raw = currentState?.vramFreqOffsetGts;
        driverLine.textContent = `Driver: ${formatDriverValue(typeof raw === 'number' ? raw : null, range)}`;
      };
      refreshDriver();
      const applyVram = async () => {
        const live = ctx.store.get();
        const deviceId = live.deviceId;
        if (deviceId === null) return;
        // Same waiver gate as every apply path (read LIVE from the store).
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
          const wanted = snapToRange(Number(slider.value), range);
          const { result, state: fresh } = await api.applySettings(deviceId, { vramFreqOffsetGts: wanted });
          if (fresh) {
            currentState = fresh;
            ctx.store.set({ state: fresh });
          }
          const per = result.perControl.vramFreqOffsetGts;
          if (per?.ok) {
            vramApplied = typeof fresh?.vramFreqOffsetGts === 'number'
              ? fresh.vramFreqOffsetGts
              : wanted;
            readout.textContent = formatValue(vramApplied, range.units);
            toast('success', 'VRAM clock applied', formatValue(vramApplied, range.units));
            ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
          } else {
            toast('error', 'VRAM clock failed', per?.message ?? errorMessage(per?.errorCode, 'vramFreqOffsetGts'));
            const freshCaps = await api.getCapabilities(deviceId);
            ctx.store.set({ caps: freshCaps });
          }
          ctx.store.set({
            lastApply: {
              ok: result.ok,
              at: Date.now(),
              detail: result.ok ? 'VRAM clock applied' : (per?.message ?? 'VRAM clock failed'),
            },
          });
          refreshDriver();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.store.set({ lastApply: { ok: false, at: Date.now(), detail: msg } });
          toast('error', 'VRAM clock failed', msg);
        }
      };
      slider.addEventListener('input', () => {
        readout.textContent = formatValue(snapToRange(Number(slider.value), range), range.units);
      });
      return el('div', { class: 'card vram-editor-card' }, [
        el('h3', { class: 'card-title', text: 'VRAM clock' }),
        el('p', {
          class: 'card-note',
          text: `Raise the video memory clock offset (${range.units}) above the driver default. Applied on demand - the driver read-back is shown below.`,
        }),
        el('div', { class: 'oc-slider-row' }, [
          el('div', { class: 'oc-slider' }, [
            el('div', { class: 'oc-track-fill' }),
            slider,
          ]),
          el('div', { class: 'oc-value' }, [readout]),
        ]),
        el('div', { class: 'oc-meta' }, [
          el('span', { class: 'oc-range', text: `${range.min} - ${range.max} ${range.units} · step ${range.step}` }),
        ]),
        el('div', { class: 'vram-editor-driver-line' }, [driverLine]),
        el('div', { class: 'vram-editor-actions' }, [
          el('button', { class: 'btn btn-primary btn-sm', text: 'Apply', onClick: () => void applyVram() }),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Reset',
            title: `Reset the editor to the driver default (${formatValue(range.default, range.units)})`,
            onClick: () => {
              slider.value = String(range.default);
              readout.textContent = formatValue(range.default, range.units);
            },
          }),
        ]),
      ]);
    };

    // --- M3-C-E: the OC-mode segmented toggle (near the top) ---------------
    const setMode = async (mode: OcMode): Promise<void> => {
      const live = ctx.store.get();
      if (mode === live.ocMode) return;
      if (mode === 'advanced') {
        // M3-C-D disclaimer: enabling Advanced warns about beyond-standard
        // limits, card/driver/PSU dependence, and the BiFrost 300 W profile.
        // M4-B: the warning shows ONLY on the first Stock->Advanced
        // toggle - the acceptance is persisted (advanced-mode-accepted-set),
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
            // mode change - the dialog simply re-appears on the next toggle.
            toast('warn', 'Advanced OC Mode', 'The confirmation could not be saved - it will be asked again.');
          }
        }
      }
      try {
        await api.ocModeSet(mode);
        // M3-C-E: mode change invalidated the backend caps cache - re-fetch
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
    // M4-I (E2): the compact Save-as-Profile button (btn-sm, in the mode
    // row right of the GPU selector - the old full-width card is REMOVED).
    // The button reads "Save as Profile" when no profile is applied,
    // "Override Profile" when activeProfileId is set (api.profilesList()).
    // M4N (C): the ACTIVE-PROFILE TAG - the M4M "Currently selected
    // profile" CARD is REMOVED; the tag is a small chip next to the save
    // button showing the loaded profile's name, ONLY while one is selected
    // (the same refreshLabel flow fills/removes it - one env fetch, both
    // the button label and the tag).
    // Click -> the shared promptModal (prefilled with the applied profile's
    // name on override) -> settingsFromState + validateSettingsPayload ->
    // profilesSave({ id: newProfileId() | the ACTIVE id, name, settings,
    // ocOnBoot: <the active profile's OWN ocOnBoot on override, false on
    // create> }) - never silently zero an at-boot profile's flag (N2) ->
    // success toast + trayRebuild.
    const saveProfileBtn = el('button', { class: 'btn btn-ghost btn-sm profile-save-btn', text: 'Save as Profile' }) as HTMLButtonElement;
    const profileTagRow = el('div', { class: 'profile-tag-row' }, [saveProfileBtn]);
    let activeProfileTag: HTMLElement | null = null;
    {
      const refreshLabel = async (): Promise<void> => {
        try {
          const env = await api.profilesList();
          const active = env.profiles.find((p) => p.id === env.settings.activeProfileId) ?? null;
          saveProfileBtn.textContent = active ? 'Override Profile' : 'Save as Profile';
          // M4N (C): the tag mirrors the button's label truth - present
          // with 'Profile: <name>' while an active profile exists, absent
          // otherwise (the row holds just the button).
          if (active) {
            if (!activeProfileTag || !activeProfileTag.isConnected) {
              activeProfileTag = el('span', {
                class: 'chip active-profile-tag',
                text: `Profile: ${active.name}`,
                title: 'Currently selected profile',
              });
              profileTagRow.prepend(activeProfileTag);
            } else {
              activeProfileTag.textContent = `Profile: ${active.name}`;
            }
          } else {
            activeProfileTag?.remove();
            activeProfileTag = null;
          }
        } catch {
          // degraded: keep the current label + tag (the click re-reads anyway)
        }
      };
      void refreshLabel();
      saveProfileBtn.addEventListener('click', () => {
        void (async () => {
          let active: Profile | null = null;
          try {
            const env = await api.profilesList();
            active = env.profiles.find((p) => p.id === env.settings.activeProfileId) ?? null;
          } catch {
            // degraded: fall back to the create flow (never a wrong override)
          }
          const title = active ? 'Override Profile' : 'Save as Profile';
          const name = await promptModal(title, active?.name ?? '');
          if (!name) return;
          const settings = settingsFromState(ctx.store.get().state as DeviceState);
          if (!validateSettingsPayload(settings)) {
            toast('error', 'Could not save profile', 'The settings payload failed validation - this is a bug.');
            return;
          }
          try {
            await api.profilesSave({
              id: active?.id ?? newProfileId(),
              name,
              settings,
              ocOnBoot: active?.ocOnBoot ?? false,
            });
            toast('success', active ? 'Profile overridden' : 'Profile saved', name);
            void api.trayRebuild().catch(() => {});
            // M4N (C): the save may have changed the ACTIVE profile (an
            // override renames it) - re-fetch the button label + the tag (a
            // create with no active slot leaves the tag absent).
            void refreshLabel();
          } catch (err) {
            toast('error', 'Profile save failed', err instanceof Error ? err.message : String(err));
          }
        })();
      });
    }

    // M4-B: the label sits ABOVE the segmented control as a caption -
    // a label inside the pill made the whole control read as a single
    // "OC mode" button. The pill now holds only the two choices.
    // M4-D2 (§8): the row is a FLEX ROW - the "Tuning | Fan Curve" view pill
    // and the Stock/Advanced OC-mode pill at the SAME HEIGHT (identical
    // label-over-toggle columns; the ui-verify pin asserts the pills'
    // getBoundingClientRect tops are equal).
    // M4-I (E1): the row order is View FIRST, then OC Mode, then the GPU
    // selector, then the compact Save-as-Profile button (the plan's swap).
    // M4-F: the compact GPU selector rides the row (a label-over-select
    // column, same height pattern as the pills). Hidden with <= 1 device
    // (the honest single-device degradation). The switch re-renders this
    // page (selectDevice) - the sliders then derive from the new device's
    // caps/state.
    // M4-I (E2): the Save-as-Profile action is a COMPACT btn-sm button in
    // the row, right of the selector - its own label-over-button column so
    // its top aligns with the pills' (the pin asserts the bounding tops
    // match). The old full-width Save-as-Profile CARD is REMOVED.
    const deviceSelect = buildDeviceSelect(ctx.store, (id) => void selectDevice(id));
    const modeRow = el('div', { class: 'oc-mode-row' }, [
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
      // M4J clarification: the OC-mode column (Stock/Advanced pill) renders
      // on EVERY device as in 1.0.3 - the user clarified that "Advanced
      // gone for Alchemist" means ONLY the bottom Advanced EXPERT SETTINGS
      // section (keyed on advancedUi below), never the mode pill.
      el('div', { class: 'oc-mode-col oc-mode-col-mode' }, [
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
      ...(deviceSelect ? [el('div', { class: 'oc-mode-col device-select-col' }, [
        el('span', { class: 'oc-mode-label', text: 'GPU' }),
        deviceSelect,
      ])] : []),
      // M4N (C): the profile column holds the TAG ROW - the save button
      // plus the active-profile tag (a flex row; the tag is absent while no
      // profile is selected, so the row holds just the button - the
      // .profile-tag-row flex keeps the button's TOP aligned with the
      // pills' regardless of the tag, the ui-verify alignment pin).
      ...(saveProfileBtn ? [el('div', { class: 'oc-mode-col profile-save-col' }, [
        el('span', { class: 'oc-mode-label', text: 'Profile' }),
        profileTagRow,
      ])] : []),
    ]);
    // M4-H (A3)/M4-I (E2): while the FAN view is active the OC-mode
    // (Stock/Advanced) column AND the compact Save-as-Profile button of the
    // shared mode row are HIDDEN - classes on the row + CSS (the View pill
    // + the GPU selector stay). Applied on the INITIAL fan-view render
    // (the #/fan redirect path - N6) AND inside setView.
    const syncModeRowForView = (): void => {
      modeRow.classList.toggle('fan-hides-oc-column', view === 'fan');
      modeRow.classList.toggle('fan-hides-save-btn', view === 'fan');
    };
    syncModeRowForView();

    // M4-D2 (§8): the view switch re-renders ONLY the sub-view container -
    // the OC slider state (values/applied - module-level) survives the
    // round trip and the fan editor's own module state survives too.
    // M4-H (A3): the OC-mode column hide follows the view (N6 - the class
    // is also applied on the INITIAL fan-view render above).
    const setView = (v: 'tuning' | 'fan'): void => {
      if (view === v) return;
      view = v;
      renderView();
      modeRow.querySelectorAll<HTMLButtonElement>('.tuning-view-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === view);
      });
      syncModeRowForView();
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

        // M4J (D) + clarification: the Advanced section renders ONLY on
        // vramFreqOffset-capable devices (Battlemage) and holds ONLY the
        // VRAM clock editor. On Alchemist (a770/arc-igpu/pro-b50) the whole
        // section is REMOVED - the gpuLock editor + the vfCurve/
        // vramVoltOffset rows are gone per the user (profiles can still
        // apply those values via the state machinery - documented). The
        // OC-mode pill above is NOT affected (renders on every device).
        ...(advancedUi
          ? [el('details', { class: 'card advanced-card' }, [
            el('summary', { class: 'card-title advanced-summary', text: 'Advanced (VRAM overclocking)' }),
            el('div', { class: 'card-body' }, [
              buildVramEditor(ctx),
            ]),
          ])]
          : []),

        applyBtn as Node,
      ];
      viewContainer.append(...body);
      updateFloating();
    };

    // M9: `only` - the per-card apply path: the SAME machinery (waiver
    // gate, elevation toast, busy state, per-control toasts + the applied
    // reference) with a single-control payload `{ [key]: value }`.
    const apply = async (ctx: PageContext, only?: string) => {
      const live = ctx.store.get();
      const deviceId = live.deviceId;
      if (deviceId === null || !caps) return;
      const settings = only !== undefined
        ? ({ [only]: values[only] } as unknown as Settings)
        : buildScalarSettings(values);
      if (!validateSettingsPayload(settings)) {
        toast('error', 'Apply aborted', 'The settings payload failed validation - this is a bug.');
        return;
      }
      const deviceName = caps.deviceName || 'this GPU';
      // M3-C review F4: the waiver gate reads the LIVE store's caps, never
      // the render-closure caps - an in-session acceptance (this session's
      // waiver-accept) must not re-prompt on the next apply. The closure
      // caps lag until a re-render (the post-apply store update is a
      // content-only caps change that does not re-render the page).
      const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, deviceName);
      if (decision === 'cancelled') {
        toast('info', 'Apply cancelled', 'The warranty waiver must be accepted before overclocking.');
        return;
      }
      // M4-A: an in-page acceptance patches the store caps IMMEDIATELY (not
      // only post-apply) - the dashboard's waiver health row flips green on
      // the next caps-change re-render, and stays green even if the apply
      // below then fails/throws.
      {
        const cur = ctx.store.get();
        if (cur.caps && cur.caps.waiverAccepted !== true) {
          ctx.store.set({ caps: { ...cur.caps, waiverAccepted: true } });
        }
      }
      // M3-C-D: no per-apply extended-range confirm - the mode gate in main
      // is the honesty (stock refuses, advanced already warned at enable).
      // M2C-C: a non-elevated product app delegates the apply to the
      // elevated self-worker (one UAC prompt) - explain BEFORE the prompt.
      // M4-D2: the packaged EXE is asInvoker now - the workerApply toast
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
        // M1 risk note: IGS may change OC state - refresh after every apply.
        // M3-C-F: EVERY card refreshes from the fresh state in place (the
        // "Driver:" readout, the slider, the chips) - no navigation needed.
        // M3-C review F2: only store a NON-NULL fresh state - a refusal
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
            // B5(a): a control that applied becomes the APPLIED reference -
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
          // M4-B: a waiver-not-set failure must not dead-end the
          // first apply with a confusing error - re-prompt the waiver dialog
          // AUTOMATICALLY (the store flag was just refreshed, so the dialog
          // shows) and retry ONCE. Never a loop; on success the counter
          // resets, so a later driver-side loss still gets its own retry.
          if (waiverRetryCount === 0
            && Object.values(result.perControl).some((p) => p?.errorCode === 'waiver-not-set')) {
            waiverRetryCount += 1;
            const live2 = ctx.store.get();
            const decision = await ensureWaiver(deviceId, live2.caps?.waiverAccepted === true, deviceName);
            if (decision === 'accepted') {
              // The store caps flag must be patched BEFORE the retry - the
              // retry re-enters the pre-apply waiver gate, which reads the
              // store flag; without the patch it would re-show the dialog
              // (the user just accepted - no second prompt).
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
    // (renderView builds it - the OC controls or the fan curve editor).
    viewContainer = el('div', { class: 'tuning-view' });
    container.append(
      el('h1', { class: 'page-title', text: 'Tuning' }),
      el('p', {
        class: 'page-subtitle',
        text: view === 'fan'
          ? 'Edit the fan curve or switch the fan mode. Changes apply on demand.'
          : (controls.length === 0
            ? 'This GPU does not expose any overclocking controls (locked or telemetry-only).'
            : 'Values are clamped to the range reported by this GPU. Changes apply on demand - nothing is applied until you press Apply.'),
      }),
      // M4-A (correction): the waiver STATUS lives ONLY in the dashboard
      // GPU Health card - this page keeps no waiver UI beyond the apply-time
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
    // SURFACE - full re-render (ranges/units change; the in-place refresh
    // cannot). Content comparison: the page's own post-apply caps re-set
    // ({ ...caps, waiverAccepted }) is NOT a surface change. The re-render
    // keeps the current sub-view (module-level `view`).
    if (ocCapsChanged(lastRenderedCaps, s.caps)) {
      tuningPage.render(container, ctx);
      return;
    }
    // M4-D2 (§8): the fan sub-view only tracks the RPM marker + readout on
    // telemetry ticks (the editor's own redraw handles its content - same
    // contract as the removed Fan page's onUpdate).
    if (view === 'fan') {
      updateFanReadout(container, ctx);
      return;
    }
    // M3-C-F: refresh the cards IN PLACE when the store's state slot changed
    // (an apply / profile load / external state change while this page is
    // current) - no full rebuild, no navigation.
    if (ocStateChanged(currentState, s.state)) {
      currentState = s.state;
      // Re-sync slider values from the driver for controls that were never
      // applied in this render (external state changes - profile load, tray
      // apply). Controls with an applied reference keep the user's position
      // (the B5 lag behavior: the chip reflects the applied value).
      for (const key of Object.keys(values)) {
        if (key in applied) continue;
        const raw = currentState?.[key as keyof DeviceState];
        // M4-B step-5 F1: the restore snap goes through the CLAMPED range
        // too - a raw (drift-wide) range would snap values[key] beyond the
        // exposed slider max and a subsequent apply would send it.
        const range = cardSliderRange(s.caps, key);
        if (typeof raw === 'number' && range) values[key] = snapToRange(raw, range);
      }
      for (const key of cards.keys()) refreshCard(key);
      updateFloating();
    }
  },
};
