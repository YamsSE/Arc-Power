// Arc Power — Overclocking page: one card per supported control (slider,
// clamps, per-card reset), the M3-C-E OC-mode segmented toggle (Stock /
// Advanced with the beyond-Intel disclaimer), the Advanced disclosure for
// expert controls, and a floating Apply button anchored bottom-left that
// appears ONLY when a setting differs from the loaded driver state (dirty)
// and disappears when clean.
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

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { snapToRange, normalizedPosition, formatValue, formatDriverValue, isOffGrid } from '../pure/slider.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
import { buildScalarSettings, validateSettingsPayload, isNoopApply, clampExposedRange, computeDirtyVsApplied, isScalarDirtyVsApplied, ocStateChanged, ocCapsChanged } from '../pure/settings.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { showAdvancedModeConfirm } from '../components/confirm-dialog.ts';
import { toast } from '../components/toast.ts';
import type { RangeInfo, Capabilities, DeviceState, OcMode } from '../types.ts';

// The pure refresh-signature helpers live in pure/settings.ts (unit-tested
// there); this page re-exports them so the import surface stays local.
export { ocStateChanged, ocCapsChanged } from '../pure/settings.ts';

// Display order only — support comes from caps.ranges, limits from the ranges.
const CONTROL_ORDER = ['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'powerLimitW', 'tempLimitC'];
const EXPERT_CONTROLS: Array<{ key: string; label: string }> = [
  { key: 'gpuLock', label: 'GPU lock (voltage/frequency pair)' },
  { key: 'vfCurve', label: 'Custom VF curve' },
  { key: 'vramFreqOffsetGts', label: 'VRAM frequency offset' },
  { key: 'vramVoltOffsetV', label: 'VRAM voltage offset' },
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
const cards = new Map<string, HTMLElement>();
const valueNodes = new Map<string, HTMLElement>();
const driverNodes = new Map<string, HTMLElement>();
const chipNodes = new Map<string, HTMLElement>();
let applyBtn: HTMLButtonElement | null = null;
let applying = false;

function resetPageState(state: DeviceState, caps: Capabilities) {
  values = {};
  applied = {};
  currentState = state;
  lastRenderedCaps = caps;
  renderCaps = caps;
  applying = false;
  cards.clear();
  valueNodes.clear();
  driverNodes.clear();
  chipNodes.clear();
  applyBtn = null;
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
 *  slider, value readout, the "Driver:" readout, the chip. */
function refreshCard(key: string) {
  const caps = renderCaps;
  const range = caps?.ranges[key];
  if (!range) return;
  const value = values[key];
  const input = cards.get(key)?.querySelector<HTMLInputElement>(`input[type="range"]`);
  const fill = cards.get(key)?.querySelector<HTMLElement>('.oc-track-fill');
  const valueNode = valueNodes.get(key);
  const driverNode = driverNodes.get(key);
  if (input) input.value = String(value);
  if (fill) fill.style.width = `${normalizedPosition(value, range) * 100}%`;
  if (valueNode) valueNode.textContent = formatValue(value, range.units);
  // The "Driver:" readout always reflects the FRESH state — never built once
  // at render (the stale part that forced the leave-and-return dance).
  if (driverNode) {
    const raw = currentState?.[key as keyof DeviceState];
    driverNode.textContent = formatDriverValue(typeof raw === 'number' ? raw : null, range);
  }
  refreshChip(key);
  updateFloating();
}

function updateFloating() {
  if (!applyBtn) return;
  if (applying) return;
  applyBtn.hidden = !computeDirtyVsApplied(buildScalarSettings(values), currentState as DeviceState, applied);
}

export const overclockingPage: Page = {
  id: 'overclocking',

  render(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    const caps = s.caps;
    const state = s.state;
    clear(container);
    resetPageState(state as DeviceState, caps as Capabilities);

    if (!caps || !state) {
      container.append(el('p', { class: 'page-subtitle', text: 'Loading device capabilities…' }));
      return;
    }
    if (s.deviceId === null) {
      container.append(el('p', { class: 'page-subtitle', text: 'No GPU available.' }));
      return;
    }

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
      const range: RangeInfo = clampExposedRange(caps.ranges[key], key, caps) as RangeInfo;
      const rawDriver = state[key as keyof DeviceState];
      const driverValue = typeof rawDriver === 'number' ? rawDriver : null;
      const driverText = formatDriverValue(driverValue, range);
      const offGrid = isOffGrid(driverValue, range);

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
              min: range.min,
              max: range.max,
              step: range.step,
              value: values[key],
              oninput: (e: Event) => {
                const raw = Number((e.target as HTMLInputElement).value);
                values[key] = snapToRange(raw, range);
                refreshCard(key);
              },
            }),
          ]),
          el('div', { class: 'oc-value', text: formatValue(values[key], range.units) }),
        ]),
        // M3-C-G: the preset chips are gone — the meta row is the range line
        // only (single line; the freed space makes the tab more compact).
        el('div', { class: 'oc-meta' }, [
          el('span', { class: 'oc-range', text: `${range.min} – ${range.max} ${range.units} · step ${range.step}` }),
        ]),
        el('div', { class: 'oc-card-actions' }, [
          el('span', { class: 'chip oc-chip-status', hidden: true }),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: 'Reset to default',
            onClick: () => {
              values[key] = snapToRange(range.default, range);
              refreshCard(key);
            },
          }),
        ]),
      ]);

      valueNodes.set(key, card.querySelector<HTMLElement>('.oc-value') as HTMLElement);
      driverNodes.set(key, card.querySelector<HTMLElement>('.oc-driver-value') as HTMLElement);
      chipNodes.set(key, card.querySelector<HTMLElement>('.oc-chip-status') as HTMLElement);
      cards.set(key, card);
      refreshCard(key);
      return card;
    };

    // --- M3-C-E: the OC-mode segmented toggle (near the top) ---------------
    const setMode = async (mode: OcMode): Promise<void> => {
      const live = ctx.store.get();
      if (mode === live.ocMode) return;
      if (mode === 'advanced') {
        // M3-C-D disclaimer: enabling Advanced warns about beyond-standard
        // limits, card/driver/PSU dependence, and the BiFrost 300 W profile.
        const confirmed = await showAdvancedModeConfirm(caps.deviceName || 'this GPU');
        if (!confirmed) return;
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
    const modeToggle = (mode: OcMode) => el('div', { class: 'oc-mode-toggle' }, [
      el('span', { class: 'oc-mode-label', text: 'OC mode' }),
      el('button', {
        class: `oc-mode-btn${mode === 'stock' ? ' active' : ''}`,
        text: 'Stock',
        onClick: () => void setMode('stock'),
      }),
      el('button', {
        class: `oc-mode-btn${mode === 'advanced' ? ' active' : ''}`,
        text: 'Advanced',
        onClick: () => void setMode('advanced'),
      }),
    ]);

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
      // M3-C-B: gated on !elevated — the always-elevated packaged EXE applies
      // in-process and must never see the approval toast.
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
        // M3-A: record the outcome for the dashboard "OC working" health row
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
        } else {
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

    const body: Array<Node | string> = [
      el('h1', { class: 'page-title', text: 'Overclocking' }),
      el('p', {
        class: 'page-subtitle',
        text: controls.length === 0
          ? 'This GPU does not expose any overclocking controls (locked or telemetry-only).'
          : 'Values are clamped to the range reported by this GPU. Changes apply on demand — nothing is applied until you press Apply.',
      }),
    ];
    // M4-A (user correction): the waiver STATUS lives ONLY in the dashboard
    // GPU Health card — this page keeps no waiver UI beyond the apply-time
    // dialog gate (ensureWaiver above).
    if (controls.length > 0) body.push(modeToggle(s.ocMode));
    body.push(
      controls.length > 0
        ? el('div', { class: 'card-stack oc-stack' }, controls.map(buildCard))
        : el('div', { class: 'card', text: 'No overclocking controls are available on this device.' }),

      el('details', { class: 'card advanced-card' }, [
        el('summary', { class: 'card-title advanced-summary', text: 'Advanced (expert controls)' }),
        el('div', { class: 'card-body' }, EXPERT_CONTROLS.map(({ key, label }) => {
          const supported = caps.controls[key] === true;
          const cur = state[key as keyof DeviceState];
          const current = key === 'gpuLock'
            ? (cur && (cur as { voltageV: number }).voltageV !== 0 ? `${(cur as { voltageV: number }).voltageV} V / ${(cur as { freqMhz: number }).freqMhz} MHz` : 'Dynamic (unlocked)')
            : cur === null || cur === undefined ? '—' : JSON.stringify(cur);
          return el('div', { class: 'expert-row' }, [
            el('span', { class: 'expert-label', text: label }),
            el('span', { class: 'expert-value', text: String(current) }),
            el('span', { class: 'expert-status', text: supported ? 'Supported — editing arrives in M4' : 'Unsupported on this GPU' }),
          ]);
        })),
      ]),

      applyBtn as Node,
    );
    container.append(...body);

    updateFloating();
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    // M3-C-F: a mode toggle / featureset swap changed the capability
    // SURFACE — full re-render (ranges/units change; the in-place refresh
    // cannot). Content comparison: the page's own post-apply caps re-set
    // ({ ...caps, waiverAccepted }) is NOT a surface change.
    if (ocCapsChanged(lastRenderedCaps, s.caps)) {
      overclockingPage.render(container, ctx);
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
        const range = s.caps?.ranges[key];
        if (typeof raw === 'number' && range) values[key] = snapToRange(raw, range);
      }
      for (const key of cards.keys()) refreshCard(key);
      updateFloating();
    }
  },
};
