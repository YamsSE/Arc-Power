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
// card's Offset/Clock segmented toggle (Wattman-style) shipped here - the
// Clock mode is REMOVED in M17e (the pure/clock.ts helpers died with it;
// the offset presentation is the only mode - the Offset|Lock toggle
// replaces the freq toggle in Run B); (3) the gpuLock editor card ships in
// the Advanced section (Voltage + Frequency inputs + Apply/Reset, gated on
// caps.controls.gpuLock - the backend apply paths already existed);
// (4) expert-row texts are honest: gpuLock = "Editing available",
// vfCurve/VRAM rows = "M5" (no apply path).
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
import { chipState } from '../pure/chip.ts';
import { applyFailureText, CONTROL_LABELS } from '../pure/errors.ts';
import { buildScalarSettings, validateSettingsPayload, isNoopApply, computeDirtyVsApplied, isControlDirtyVsApplied, isScalarDirtyVsApplied, ocStateChanged, ocCapsChanged, cardSliderRange, advancedUiVisible, parseGpuLockInput, formatLockPair, gpuLockToastPair, clampGpuLock, formatLockRange, GPU_LOCK_VOLT_MAX_V, GPU_LOCK_FREQ_MAX_MHZ } from '../pure/settings.ts';
import { formatPlReadout } from '../pure/pl-readout.ts';
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
import type { RangeInfo, Capabilities, DeviceState, OcMode, Profile, Settings, PowerLimitsRead } from '../types.ts';

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
// M17e: the M4-B Offset/Clock mode machinery is REMOVED (freqMode /
// baseClock / setFreqMode / the pure/clock.ts helpers died with the Clock
// mode - the offset presentation is the only mode; the Offset|Lock toggle
// replaces the freq card's mode toggle in Run B).
// M17e (Run B): the freq card's Offset|Lock mode - the gpuLock editor
// renders INSIDE the freq card in Lock mode (the standalone M17d card is
// folded in); the mode switch resets the other side IN THE DRAFT (Lock ->
// the offsets draft 0; Offset -> the lock drafts (0,0)); the lock apply
// zeroes the offsets + the offset apply unlocks (the atomic payloads the
// backend normalizes + orders).
let lockMode = false;
// M4-B: the automatic waiver re-prompt + single retry counter - the
// driver can lose the waiver while settings.json still says accepted; the
// first apply then fails with waiver-not-set and re-prompts + retries once.
// Reset on every successful apply.
let waiverRetryCount = 0;
const cards = new Map<string, HTMLElement>();
const valueNodes = new Map<string, HTMLElement>();
const driverNodes = new Map<string, HTMLElement>();
// M4-B step-5 F2: the card's meta range line - refreshCard keeps it in sync
// with the slider range (the caption describes the CURRENT slider).
const rangeNodes = new Map<string, HTMLElement>();
const chipNodes = new Map<string, HTMLElement>();
// M9: the per-card Apply button (the chip state machine) - visible ONLY
// while that card is dirty; clicking it applies THAT card only.
const chipApplyNodes = new Map<string, HTMLButtonElement>();
// M17d (Run D): the gpuLock card's current-lock read-out (in-place refresh
// target - the same pattern as the slider driver lines; (0,0) = Dynamic).
let lockCurrentNode: HTMLElement | null = null;
// M17e (Run B): the lock editor's Apply button - its enabled state mirrors
// the DIRTY semantics (enabled when the typed pair differs from the driver
// lock - the isControlDirtyVsApplied pair compare; disabled otherwise).
let lockApplyBtn: HTMLButtonElement | null = null;
// M17e: the last successfully-applied gpuLock pair (the per-control applied
// reference for the lock editor's dirty judgment - the B5 pattern: the chip
// clears even while the driver read-back lags).
let appliedLock: { voltageV: number; freqMhz: number } | null = null;
// M17f: the power-limit card's sysman PL1/PL2 read-out line - the
// Level Zero Sysman layer's sustained (PL1) + burst (PL2) limits. The
// freshness = per-apply (the apply paths re-fetch) + one-shot at render
// (boot); the element text is 'PL1 210 W / PL2 210 W' when the layer
// answers, the honest 'PL1 - / PL2 -' when absent.
let sysmanLimitsNode: HTMLElement | null = null;
// M17g: the PER-DEVICE SESSION-tracked last-applied PL2 - fed ONLY from
// the apply envelope's pl2Note (the '(set)' fallback when the sysman layer
// is absent; the boot one-shot + the profile/tray applies never feed it -
// they show the sysman read or '-'; session-scoped, never persisted).
// M17n (round-1 S1): the entry carries the LANDED FLAG (no longer
// discarded at the feed) - pl-readout.ts branches the sentence on it (the
// clamp class's value-accurate sentence vs the refused class's kept
// sentence).
const pl2SetByDevice = new Map<number, { landed: boolean; valueW: number; ceilingW?: number; requestedW?: number }>();
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
  // M17f (step-4 N1): `lockMode` is NOT reset here - it is the same
  // module-level session state as `view` (the fan sub-view survives a
  // full re-render too). A caps-change re-render mid-Lock-mode must keep
  // the mode; renderView re-applies the presentation from it.
  appliedLock = null;
  cards.clear();
  valueNodes.clear();
  driverNodes.clear();
  rangeNodes.clear();
  chipNodes.clear();
  chipApplyNodes.clear();
  lockCurrentNode = null;
  lockApplyBtn = null;
  sysmanLimitsNode = null;
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

/** M17f: format the sysman limits read-out - 'PL1 210 W / PL2 210 W' when
 *  the layer answers, the honest 'PL1 - / PL2 -' when absent/garbage.
 *  M17g: the read-out falls back to the session-tracked '(set)' value
 *  (the apply envelope's pl2Note) when the sysman layer is absent - the
 *  PL2 line shows the last-applied value marked '(set)' (with the honest
 *  ceiling sentence when the V2 companion was refused), '-' only when
 *  NOTHING was applied in the session AND the sysman is absent.
 *  M17n (round-1 S1): the LANDED FLAG branches the sentence - the clamp
 *  class (landed + ceilingW) renders the value-accurate sentence, the
 *  refused class (landed false + ceilingW) keeps its sentence.
 *  M17o: the clamp class's requestedW drives the promise sentence ('it
 *  will be raised to <requestedW> W automatically when the sysman layer
 *  finishes initializing' when valueW < requestedW). */
function formatSysmanLimits(limits: PowerLimitsRead | null, set: { landed?: boolean; valueW: number; ceilingW?: number; requestedW?: number } | undefined, enforcedW: number | null | undefined): string {
  return formatPlReadout(limits, set, enforcedW);
}

/** M17f: refresh the power-limit card's PL2 read-out from the sysman layer
 *  (per-apply + the boot one-shot; a failure keeps the honest '-' line).
 *  M17f (step-4 N2): DEVICE-SCOPED - the deviceId threads into the read
 *  (the domain is per-device; a null deviceId = no device - nothing to
 *  read). M17g: the '(set)' fallback rides the per-device session state
 *  (fed ONLY from the apply envelope's pl2Note). */
async function refreshSysmanLimits(deviceId: number | null): Promise<void> {
  if (!sysmanLimitsNode || deviceId === null) return;
  let limits: PowerLimitsRead | null = null;
  try {
    limits = await api.powerLimitsRead(deviceId);
  } catch {
    limits = null;
  }
  const enforced = typeof currentState?.powerLimitW === 'number' && Number.isFinite(currentState.powerLimitW)
    ? (currentState.powerLimitW as number)
    : null;
  sysmanLimitsNode.textContent = formatSysmanLimits(limits, pl2SetByDevice.get(deviceId), enforced);
}

/** M17d (Run D): refresh the gpuLock card's current-driver-lock read-out
 *  from the module-level state (the (0,0) pair = 'Dynamic (unlocked)'). */
function refreshLockReadout(): void {
  if (!lockCurrentNode) return;
  lockCurrentNode.textContent = `Lock: ${formatLockPair(currentState?.gpuLock ?? null)}`;
}

/** M17e (Run B): refresh the lock editor's dirty semantics - the Apply
 *  button enables only when the TYPED pair differs from the driver lock
 *  (the isControlDirtyVsApplied pair compare against the applied reference,
 *  falling back to the driver state - the same B5 pattern the scalar cards
 *  use). A pristine editor (typed == driver lock) disables the button. */
function refreshLockEditor(): void {
  if (!lockApplyBtn) return;
  const voltageInput = cards.get('gpuFreqOffsetMhz')?.querySelector<HTMLInputElement>('input[data-lock-field="voltageV"]');
  const freqInput = cards.get('gpuFreqOffsetMhz')?.querySelector<HTMLInputElement>('input[data-lock-field="freqMhz"]');
  if (!voltageInput || !freqInput) return;
  const parsed = parseGpuLockInput(voltageInput.value, freqInput.value);
  const appliedRef: Record<string, unknown> = appliedLock ? { gpuLock: appliedLock } : {};
  const dirty = parsed.ok
    && isControlDirtyVsApplied('gpuLock', { gpuLock: parsed.pair }, currentState, appliedRef);
  lockApplyBtn.disabled = !dirty || applying;
}

/** M3-C-F: refresh ONE card in place from the current values + fresh state:
 *  slider, value readout, the "Driver:" readout, the chip. M4-B step-5 F1:
 *  the range derives from the CLAMPED exposure (same helper as buildCard) -
 *  the raw caps must never re-widen the slider after build (the M2C-A F3
 *  guard). M17e: the M4-B Clock-mode presentation is REMOVED - the freq
 *  card slides/reads out the OFFSET directly (the offset stays the only
 *  mode; pure/clock.ts died with it). */
function refreshCard(key: string) {
  const caps = renderCaps;
  const range = cardSliderRange(caps, key);
  if (!range) return;
  const value = values[key];
  const sliderRange = range;
  const displayValue = value;
  const input = cards.get(key)?.querySelector<HTMLInputElement>(`input[type="range"]`);
  const fill = cards.get(key)?.querySelector<HTMLElement>('.oc-track-fill');
  const valueNode = valueNodes.get(key);
  const driverNode = driverNodes.get(key);
  const rangeNode = rangeNodes.get(key);
  if (input) {
    input.min = String(sliderRange.min);
    input.max = String(sliderRange.max);
    input.step = String(sliderRange.step);
    input.value = String(snapToRange(displayValue, sliderRange));
  }
  if (fill) fill.style.width = `${normalizedPosition(displayValue, sliderRange) * 100}%`;
  if (valueNode) valueNode.textContent = formatValue(displayValue, sliderRange.units);
  // The meta range caption describes the CURRENT slider (the offset range
  // the card was built with - the en-dash caption format is shared).
  if (rangeNode) rangeNode.textContent = `${sliderRange.min} – ${sliderRange.max} ${sliderRange.units} · step ${sliderRange.step}`;
  // The "Driver:" readout always reflects the FRESH state - never built once
  // at render (the stale part that forced the leave-and-return dance).
  if (driverNode) {
    const raw = currentState?.[key as keyof DeviceState];
    driverNode.textContent = formatDriverValue(typeof raw === 'number' ? raw : null, sliderRange);
  }
  refreshChip(key);
  updateFloating();
}

function updateFloating() {
  if (!applyBtn) return;
  if (applying) return;
  // M17e (round-2 N5): the floating apply is FORCE-HIDDEN in Lock mode -
  // the lock card owns its apply (a slider drag in Lock mode must NOT
  // re-enable the floating button; the per-card offset chip remains the
  // atomic-unlock path when the mode flips back to Offset).
  if (lockMode) {
    applyBtn.hidden = true;
    return;
  }
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

    // M17e (Run B): the gpuLock-capable freq card's Lock-mode editor element
    // references - created inside buildCard (the freq-card branch), read by
    // setLockMode + the apply path (declared here so the closures resolve).
    let lockVoltageInput: HTMLInputElement | null = null;
    let lockFreqInput: HTMLInputElement | null = null;
    // The card's lock support flag (a card WITHOUT lock support - b580 -
    // shows the offset card with NO toggle; the lock editor + the atomic
    // payload compositions are gated on it).
    const lockSupported = caps.controls.gpuLock === true;

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
      // M17e: the M4-B Clock-mode presentation is REMOVED - the slider
      // range is the offset range, always (the offset stays the only mode).
      const sliderRange = range;
      const rawDriver = state[key as keyof DeviceState];
      const driverRaw = typeof rawDriver === 'number' ? rawDriver : null;
      const driverValue = driverRaw;
      const driverText = formatDriverValue(driverValue, sliderRange);
      const offGrid = isOffGrid(driverValue, sliderRange);

      // M17e (Run B): the LOCK-MODE editor - rendered INSIDE the freq card
      // (the M17d standalone buildLockCard is folded in; the .gpu-lock-editor
      // + .gpu-lock-current classes survive so the M17d read-out pins keep
      // working). Only on gpuLock-capable cards (b580 renders the offset
      // card with NO toggle + NO editor).
      let lockEditorEl: HTMLElement | null = null;
      let lockCurrentLine: HTMLElement | null = null;
      if (key === 'gpuFreqOffsetMhz' && lockSupported) {
        const lockBounds = caps.lockRange;
        const lockVoltMax = Number.isFinite(lockBounds?.voltMax) ? (lockBounds?.voltMax as number) : GPU_LOCK_VOLT_MAX_V;
        const lockFreqMax = Number.isFinite(lockBounds?.freqMax) ? (lockBounds?.freqMax as number) : GPU_LOCK_FREQ_MAX_MHZ;
        lockVoltageInput = el('input', {
          type: 'number',
          // The min stays 0 (the S2 (0,0)-unlock bypass: a positive
          // voltMin must never make the unlock pair unreachable) - the
          // non-zero pair clamps to the range on apply.
          min: '0',
          max: String(lockVoltMax),
          step: '0.001',
          value: '0',
          dataset: { lockField: 'voltageV' },
          title: `Absolute lock voltage (V). 0 = don't touch voltage (the driver keeps the stock voltage at the locked frequency).`,
        });
        lockFreqInput = el('input', {
          type: 'number',
          min: '0',
          max: String(lockFreqMax),
          step: '1',
          value: '0',
          dataset: { lockField: 'freqMhz' },
          title: 'Absolute lock frequency (MHz).',
        });
        lockCurrentLine = el('div', { class: 'gpu-lock-current' });
        lockApplyBtn = el('button', {
          class: 'btn btn-primary btn-sm',
          text: 'Apply',
        }) as HTMLButtonElement;
        const resetToDynamic = (): void => {
          if (lockVoltageInput) lockVoltageInput.value = '0';
          if (lockFreqInput) lockFreqInput.value = '0';
          refreshLockEditor();
        };
        const applyLock = async (): Promise<void> => {
          const live = ctx.store.get();
          const deviceId = live.deviceId;
          if (deviceId === null || !caps) return;
          // M4-B step-5 F3: parse + validate FIRST - empty/whitespace fields
          // are rejected before conversion (Number('') === 0 would silently
          // apply the legal 0 V / 0 MHz UNLOCK pair); non-numeric fields too.
          if (!lockVoltageInput || !lockFreqInput) return;
          const parsed = parseGpuLockInput(lockVoltageInput.value, lockFreqInput.value);
          if (!parsed.ok) {
            toast('error', 'Fixed Clock / Voltage Lock', 'Voltage and frequency must be numbers.');
            return;
          }
          // M17e (N8): the renderer clamps the typed pair to caps.lockRange
          // (the clampGpuLock mirror - the (0,0) unlock bypass included) so
          // the payload the card sends is the pair the driver will receive;
          // main's applyLock stays the authoritative gate.
          const clamped = clampGpuLock(parsed.pair, caps.lockRange);
          // Same waiver gate as every apply path (read LIVE from the store).
          // M17 (B50-class): OC-locked devices have no waiver - skipped.
          const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, caps.deviceName || 'this GPU', live.caps?.overclockingSupported !== false);
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
            setBusy(true);
            // M17e (S1c): the ATOMIC LOCK payload - the offsets zero RIDE
            // ALONG so the driver never sits in the lock-vs-offset fight
            // (IN_VOLTAGE_LOCKED_MODE); PL/TL NEVER ride the payload (the
            // user's rule - their cards stay independent).
            const { result, state: fresh } = await api.applySettings(deviceId, {
              gpuLock: clamped,
              gpuFreqOffsetMhz: 0,
              gpuVoltOffsetV: 0,
            });
            if (fresh) {
              currentState = fresh;
              ctx.store.set({ state: fresh });
            }
            const per = result.perControl.gpuLock;
            if (per?.ok) {
              // M4-B step-5 F4: report the pair the DRIVER received - the
              // read-back pair when the fresh envelope carried one (main
              // clamped the typed values), else the locally clamped pair.
              const appliedPair = gpuLockToastPair(clamped, fresh?.gpuLock, caps.lockRange);
              appliedLock = fresh?.gpuLock ?? appliedPair;
              // M17e (round-2 N2): the APPLIED pair re-syncs the editor
              // inputs - the driver received the CLAMPED pair (a typed
              // 9.9 V lands 1.5 V), so the inputs must show 1.5, never the
              // silently-lying 9.9 next to the honest read-out line; the
              // re-synced editor also stops reading dirty (typed ==
              // applied -> the Apply button disables).
              if (lockVoltageInput) lockVoltageInput.value = String(appliedPair.voltageV);
              if (lockFreqInput) lockFreqInput.value = String(appliedPair.freqMhz);
              // The atomic lock zeroed the offsets - the slider drafts
              // follow AND the applied reference follows (the driver's
              // offsets ARE 0 now - a stale pre-lock applied ref would
              // leave the floating apply falsely dirty after a mode flip
              // back).
              values['gpuFreqOffsetMhz'] = snapToRange(0, caps.ranges['gpuFreqOffsetMhz']);
              values['gpuVoltOffsetV'] = snapToRange(0, caps.ranges['gpuVoltOffsetV']);
              applied['gpuFreqOffsetMhz'] = 0;
              applied['gpuVoltOffsetV'] = 0;
              toast('success', 'Fixed Clock / Voltage Lock applied', formatLockPair(appliedPair));
              ctx.store.set({ caps: { ...caps, waiverAccepted: true } });
            } else {
              toast('error', 'Fixed Clock / Voltage Lock failed', applyFailureText(per, 'gpuLock'));
              const freshCaps = await api.getCapabilities(deviceId);
              ctx.store.set({ caps: freshCaps });
            }
            ctx.store.set({
              lastApply: {
                ok: result.ok,
                at: Date.now(),
                detail: result.ok ? 'Fixed Clock / Voltage Lock applied' : (per?.message ?? 'GPU lock failed'),
              },
            });
            // Only refresh the read-out on a NON-NULL fresh envelope - a
            // refused/null-state apply keeps the previous line (the driver
            // state is unknown, never "unlocked").
            if (fresh) refreshLockReadout();
            refreshLockEditor();
            refreshCard('gpuFreqOffsetMhz');
            refreshCard('gpuVoltOffsetV');
            updateFloating();
            void refreshSysmanLimits(deviceId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.store.set({ lastApply: { ok: false, at: Date.now(), detail: msg } });
            toast('error', 'Fixed Clock / Voltage Lock failed', msg);
          } finally {
            setBusy(false);
          }
        };
        lockApplyBtn.addEventListener('click', () => {
          if (applying) return;
          void applyLock();
        });
        lockVoltageInput.addEventListener('input', refreshLockEditor);
        lockFreqInput.addEventListener('input', refreshLockEditor);
        lockEditorEl = el('div', { class: 'gpu-lock-editor', hidden: !lockMode }, [
          el('p', {
            class: 'card-note',
            // M17f (the round-1/round-3 fold - the user's SIMPLIFIED
            // description): the M17e-era long text is REPLACED by the
            // pinned short version (the exact wording asserted by the
            // ui-verify pin).
            text: 'Fix the GPU to one voltage and frequency. 0 V / 0 MHz returns to automatic. Setting a lock clears the core and voltage offsets; setting offsets clears the lock.',
          }),
          el('div', { class: 'gpu-lock-fields' }, [
            el('label', { class: 'gpu-lock-field' }, [
              el('span', { class: 'gpu-lock-label', text: 'Voltage (V)' }),
              lockVoltageInput,
            ]),
            el('label', { class: 'gpu-lock-field' }, [
              el('span', { class: 'gpu-lock-label', text: 'Frequency (MHz)' }),
              lockFreqInput,
            ]),
          ]),
          // M17f (the round-5 fold - the user addition): the lock editor
          // DISPLAYS ITS RANGE - the per-GPU bounds from caps.lockRange
          // (the live values; the DOCUMENTED fallback text when the range
          // is absent - the same fallback the clamp uses; the honest
          // 'Range: -' when no range resolves). The inputs' max attrs
          // bind the same range (the clamp already enforces - the display
          // makes the range visible before an apply); the format follows
          // the .oc-range meta-line pattern.
          el('div', {
            class: 'gpu-lock-range',
            text: formatLockRange(caps.lockRange),
          }),
          el('div', { class: 'gpu-lock-actions' }, [
            lockApplyBtn,
            el('button', {
              class: 'btn btn-ghost btn-sm',
              text: 'Reset to Dynamic',
              title: 'Reset the editor to the default unlock pair (0 V / 0 MHz)',
              onClick: resetToDynamic,
            }),
          ]),
          lockCurrentLine,
        ]);
      }

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
              value: snapToRange(values[key], sliderRange),
              oninput: (e: Event) => {
                const raw = Number((e.target as HTMLInputElement).value);
                values[key] = snapToRange(raw, range);
                refreshCard(key);
              },
            }),
          ]),
          el('div', { class: 'oc-value', text: formatValue(values[key], sliderRange.units) }),
        ]),
        // M17e (Run B): the Offset|Lock segmented toggle replaces the M4-B
        // Offset/Clock toggle on the freq card - ONLY on gpuLock-capable
        // cards (a card WITHOUT lock support - b580 - shows the offset card
        // with NO toggle). Lock mode renders the gpuLock editor INSIDE the
        // card; switching modes resets the other side in the DRAFT.
        ...(key === 'gpuFreqOffsetMhz' && lockSupported
          ? [el('div', { class: 'oc-freq-mode-row' }, [
              el('div', { class: 'oc-mode-toggle oc-lock-mode-toggle', role: 'group', 'aria-label': 'Core clock mode' }, [
                el('button', {
                  class: `oc-mode-btn oc-lock-mode-btn${lockMode ? '' : ' active'}`,
                  dataset: { lockMode: 'offset' },
                  text: 'Offset',
                  title: 'Set the frequency as an offset (the lock apply zeroes the offsets; the offset apply unlocks)',
                  onClick: () => setLockMode('offset'),
                }),
                el('button', {
                  class: `oc-mode-btn oc-lock-mode-btn${lockMode ? ' active' : ''}`,
                  dataset: { lockMode: 'lock' },
                  text: 'Lock',
                  title: 'Lock the GPU to an absolute voltage/frequency pair (switching resets the offsets to 0)',
                  onClick: () => setLockMode('lock'),
                }),
              ]),
            ])]
          : []),
        // M3-C-G: the preset chips are gone - the meta row is the range line
        // only (single line; the freed space makes the tab more compact).
        el('div', { class: 'oc-meta' }, [
          el('span', { class: 'oc-range', text: `${sliderRange.min} – ${sliderRange.max} ${sliderRange.units} · step ${sliderRange.step}` }),
          // M17f: the power-limit card's sysman PL1/PL2 read-out line - the
          // Level Zero Sysman layer's limits when it answers, the honest
          // 'PL1 - / PL2 -' when absent (the burst/PL2 domain is invisible
          // to IGCL - the sysman layer is the read-out's source).
          ...(key === 'powerLimitW'
            ? [el('span', {
                class: 'oc-sysman-limits',
                text: 'PL1 - / PL2 -',
                title: 'The sustained (PL1) + burst (PL2) power limits reported by the Level Zero Sysman layer',
              })]
            : []),
        ]),
        // M17e (Run B): the gpuLock editor NESTED inside the freq card (the
        // M17d standalone card is folded in; visible ONLY in Lock mode).
        ...(lockEditorEl ? [lockEditorEl] : []),
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
              // M17e: the M4-B Clock-mode reset branch is REMOVED (the
              // mode died) - the default is the range default, always.
              values[key] = snapToRange(range.default, range);
              refreshCard(key);
            },
          }),
        ]),
      ]);

      valueNodes.set(key, card.querySelector<HTMLElement>('.oc-value') as HTMLElement);
      driverNodes.set(key, card.querySelector<HTMLElement>('.oc-driver-value') as HTMLElement);
      rangeNodes.set(key, card.querySelector<HTMLElement>('.oc-range') as HTMLElement);
      chipNodes.set(key, card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
      chipApplyNodes.set(key, card.querySelector<HTMLButtonElement>('.oc-chip-apply') as HTMLButtonElement);
      cards.set(key, card);
      if (lockEditorEl && lockCurrentLine) {
        lockCurrentNode = lockCurrentLine;
        refreshLockReadout();
        refreshLockEditor();
      }
      refreshCard(key);
      return card;
    };

    // M17f (step-4 N1): the Lock-mode PRESENTATION re-applier - SHARED by
    // setLockMode (the runtime toggle) and renderView (a full re-render
    // rebuilds the surface from the CURRENT module-level lockMode - the
    // volt card + the offset slider hidden + the 'GPU Lock' title flip).
    // The M17f card-replacement toggle's three effects + the Lock-mode
    // draft semantics live here so a re-render mid-Lock-mode can never
    // leave the mixed editor+slider surface with the reverted title.
    const applyLockPresentation = (): void => {
      const card = cards.get('gpuFreqOffsetMhz');
      const editor = card?.querySelector<HTMLElement>('.gpu-lock-editor');
      if (editor) editor.hidden = !lockMode;
      // M17f: the CARD-REPLACEMENT toggle - the offset slider row + the
      // whole voltage-offset card are DISPLAYED ONLY in Offset mode.
      const sliderRow = card?.querySelector<HTMLElement>('.oc-slider-row');
      if (sliderRow) sliderRow.hidden = lockMode;
      const voltCard = cards.get('gpuVoltOffsetV');
      if (voltCard) voltCard.hidden = lockMode;
      // M17f (round-3 N4): the card TITLE flips with the mode - a
      // CARD-TITLE ELEMENT MUTATION, never CONTROL_LABELS (shared by the
      // toasts + the profiles page - it must not change).
      const titleNode = card?.querySelector<HTMLElement>('.card-title');
      if (titleNode) {
        titleNode.textContent = lockMode ? 'GPU Lock' : (CONTROL_LABELS['gpuFreqOffsetMhz'] ?? 'Core clock');
      }
      if (lockMode) {
        // Lock mode: the offsets draft 0 (the user's rule - only GPU Lock
        // OR Core Offset & Voltage works at a time).
        values['gpuFreqOffsetMhz'] = snapToRange(0, caps.ranges['gpuFreqOffsetMhz']);
        values['gpuVoltOffsetV'] = snapToRange(0, caps.ranges['gpuVoltOffsetV']);
        refreshCard('gpuFreqOffsetMhz');
        refreshCard('gpuVoltOffsetV');
        // S4/N7: the typed-pair prefill comes from the driver's current
        // lock (or (0,0) when the driver holds none).
        const cur = currentState?.gpuLock && typeof currentState.gpuLock === 'object'
          ? currentState.gpuLock
          : { voltageV: 0, freqMhz: 0 };
        if (lockVoltageInput) lockVoltageInput.value = String(cur.voltageV);
        if (lockFreqInput) lockFreqInput.value = String(cur.freqMhz);
      } else {
        // Offset mode: the lock drafts (0,0) - in the DRAFT, never applied.
        if (lockVoltageInput) lockVoltageInput.value = '0';
        if (lockFreqInput) lockFreqInput.value = '0';
      }
    };

    // M17e (Run B): flip the freq card between Offset and Lock presentation.
    // Switching to Lock resets the freq/volt offsets to 0 IN THE DRAFT (the
    // mutual-exclusion rule) + prefills the editor from the driver's current
    // lock (or (0,0)); switching back drafts the lock (0,0) (never applied).
    // M17f (the USER ADDITION - the card-REPLACEMENT toggle): Lock mode
    // REPLACES the card content - the Core-Offset SLIDER row is hidden and
    // the separate Voltage-Offset CARD is NOT DISPLAYED AT ALL (the Core
    // Clock card shows EITHER the offset sliders OR the lock editor); the
    // card TITLE flips to 'GPU Lock' in Lock mode and stays 'Core clock'
    // (lowercase c - CONTROL_LABELS, shared by the toasts + profiles, is
    // never changed) in Offset mode.
    const setLockMode = (mode: 'offset' | 'lock') => {
      if (lockMode === (mode === 'lock')) return;
      lockMode = mode === 'lock';
      const card = cards.get('gpuFreqOffsetMhz');
      card?.querySelectorAll<HTMLButtonElement>('.oc-lock-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.lockMode === mode);
      });
      applyLockPresentation();
      refreshLockEditor();
      refreshLockReadout();
      updateFloating();
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
        // M17 (B50-class): OC-locked devices (overclockingSupported === false)
        // have no waiver - the gate is skipped (uniform with every apply path).
        const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, caps.deviceName || 'this GPU', live.caps?.overclockingSupported !== false);
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
            toast('error', 'VRAM clock failed', applyFailureText(per, 'vramFreqOffsetGts'));
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

    // M17e (Run B): the M17d STANDALONE Fixed Clock / Voltage Lock card is
    // REMOVED - the gpuLock editor is folded INSIDE the freq card's Lock
    // mode (the buildCard branch above - the Offset|Lock toggle + the
    // atomic applies + the caps.lockRange inputs + the new rule note).

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

        // M17e (Run B): the M17d STANDALONE Fixed Clock / Voltage Lock card
        // is REMOVED - the gpuLock editor lives INSIDE the freq card's Lock
        // mode (the buildCard branch - the Offset|Lock toggle on
        // gpuLock-capable cards; b580/arc-igpu/pro-b50 stay editor-less -
        // unsupported - and the b580 freq card shows NO toggle).

        applyBtn as Node,
      ];
      viewContainer.append(...body);
      lockCurrentNode = viewContainer.querySelector<HTMLElement>('.gpu-lock-current');
      // M17f: the power-limit card's sysman read-out - the boot one-shot
      // fetch (per-apply refreshes happen in the apply paths).
      sysmanLimitsNode = viewContainer.querySelector<HTMLElement>('.oc-sysman-limits');
      // M17f (step-4 N1): a FULL RE-RENDER (caps change - an OC-mode
      // toggle / featureset swap / device switch) must re-apply the Lock
      // presentation from the CURRENT lockMode - the volt card + the
      // offset slider hidden + the 'GPU Lock' title + the drafts/prefill
      // (the module-level lockMode survives resetPageState).
      applyLockPresentation();
      refreshLockReadout();
      refreshLockEditor();
      updateFloating();
      void refreshSysmanLimits(ctx.store.get().deviceId);
    };

    // M9: `only` - the per-card apply path: the SAME machinery (waiver
    // gate, elevation toast, busy state, per-control toasts + the applied
    // reference) with a single-control payload `{ [key]: value }`.
    const apply = async (ctx: PageContext, only?: string) => {
      const live = ctx.store.get();
      const deviceId = live.deviceId;
      if (deviceId === null || !caps) return;
      // M17e (S1c): the ATOMIC payload compositions. The OFFSET applies
      // (the per-card chips for gpuFreqOffsetMhz / gpuVoltOffsetV AND the
      // floating apply in Offset mode) carry the (0,0) unlock - a per-card
      // offset apply WHILE LOCKED clears the driver lock first (the main-
      // side write order does the unlock first; the unlock is a no-op when
      // no lock is held). Power Limit + Temp Limit NEVER ride the payload
      // (the user's rule - the lock apply never resets them and their
      // applies never touch the lock). The LOCK apply is composed by the
      // lock editor itself (the lock-mode branch - the floating apply is
      // force-hidden in Lock mode).
      let settings: Settings;
      if (only !== undefined) {
        settings = (lockSupported && (only === 'gpuFreqOffsetMhz' || only === 'gpuVoltOffsetV'))
          ? ({ [only]: values[only], gpuLock: { voltageV: 0, freqMhz: 0 } } as unknown as Settings)
          : ({ [only]: values[only] } as unknown as Settings);
      } else {
        settings = buildScalarSettings(values);
        if (lockSupported) settings = { ...settings, gpuLock: { voltageV: 0, freqMhz: 0 } };
      }
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
      // M17 (B50-class): OC-locked devices (overclockingSupported === false)
      // have no waiver - the gate is skipped (uniform with every apply path;
      // unreachable today on no-OC devices, but the guard keeps the whole
      // waiver surface uniform).
      const decision = await ensureWaiver(deviceId, live.caps?.waiverAccepted === true, deviceName, live.caps?.overclockingSupported !== false);
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
        // M3-A: record the last-apply outcome (honest: ok with what
        // changed / failed with the first error). M16: the dashboard OC
        // status row no longer displays this record (the row derives its
        // stock-state verdict from the live driver read-back) - the store
        // slot is kept because the apply paths still record it (M16 review
        // nit 1), it feeds the boot-fetch outcome mapping in app.ts, and
        // nothing in the UI reads it anymore.
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
            // hard errors keep the errorCode mapping (M17d item 0b: the
            // preference is the shared applyFailureText - the per-control
            // message wins, the errorCode mapping is the driver-shaped
            // fallback - never the 'clamps' lie for a gate refusal).
            toast('error', `${CONTROL_LABELS[key] ?? key} failed`, applyFailureText(per, key));
          } else {
            // B5(a): a control that applied becomes the APPLIED reference -
            // its chip clears and the button hides even while the driver
            // read-back lags. (b) The toast still needs a REAL change vs
            // the pre-apply read-back.
            const wanted = settings[key as keyof typeof settings];
            if (typeof wanted === 'number') applied[key] = wanted;
            // M17e: the (0,0) unlock entries ride the offset applies - the
            // lock editor's dirty reference follows the applied pair (the
            // fresh envelope pair when present, else the sent pair).
            if (key === 'gpuLock') {
              const sent = (settings.gpuLock as { voltageV: number; freqMhz: number } | undefined);
              appliedLock = fresh?.gpuLock ?? (sent ?? { voltageV: 0, freqMhz: 0 });
            }
            if (!isNoopApply(key, settings, before as DeviceState)) {
              toast('success', `${CONTROL_LABELS[key] ?? key} applied`, typeof wanted === 'number' && range ? formatValue(wanted, range.units) : '');
            }
            // per.ok && no-op -> silent (M2b-B): nothing changed, no toast.
          }
        }
        for (const key of controls) refreshCard(key);
        refreshLockReadout();
        refreshLockEditor();
        updateFloating();
        // M17g: the PL2 '(set)' session state - fed ONLY from the apply
        // envelope's pl2Note (the note fires on EVERY W-unit powerLimitW
        // apply in both modes; a payload without powerLimitW never emits).
        // Per-device (a device switch keeps its own entry); the boot
        // one-shot + the profile/tray applies never feed it - they show
        // the sysman read or '-'.
        // M17n (round-1 S1): the LANDED FLAG rides into the session state
        // (no longer discarded) - the read-out branches the sentence on it
        // (the clamp class's value-accurate sentence keyed on valueW; the
        // refused class keeps its sentence).
        if (result.pl2Note && typeof result.pl2Note.valueW === 'number') {
          pl2SetByDevice.set(deviceId, {
            landed: result.pl2Note.landed === true,
            valueW: result.pl2Note.valueW,
            ...(typeof result.pl2Note.ceilingW === 'number' ? { ceilingW: result.pl2Note.ceilingW } : {}),
            ...(typeof result.pl2Note.requestedW === 'number' ? { requestedW: result.pl2Note.requestedW } : {}),
          });
        }
        // M17f: the PL2 read-out freshness = per-apply - refresh the sysman
        // line after every apply (the power limit may have moved the burst
        // domain via the companion sync; the '(set)' fallback re-renders
        // from the session state just fed).
        void refreshSysmanLimits(deviceId);
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
            const decision = await ensureWaiver(deviceId, live2.caps?.waiverAccepted === true, deviceName, live2.caps?.overclockingSupported !== false);
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
      // GPU Status card - this page keeps no waiver UI beyond the apply-time
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
      // M17d (Run D): the gpuLock card's current-lock read-out refreshes
      // in place too (a tray apply / profile load can change the driver
      // lock while this page is current). M17e: the lock editor's dirty
      // semantics follow the fresh driver lock as well.
      refreshLockReadout();
      refreshLockEditor();
      updateFloating();
    }
  },
};
