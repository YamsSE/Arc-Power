// Arc Power — Overclocking page (M2b-B UX): one card per supported control
// (slider, clamps, presets, per-card reset), Advanced disclosure for expert
// controls, and a floating Apply button anchored bottom-left that appears
// ONLY when a setting differs from the loaded driver state (dirty) and
// disappears when clean. Apply writes every dirty control with per-control
// result toasts: no-op controls (value == driver read-back before the
// apply) stay silent, errors always toast, and a retried apply shows the
// "driver was busy — applied on retry" note. All limits come from
// Capabilities.ranges — never hardcoded.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { snapToRange, normalizedPosition, formatValue, formatDriverValue, isOffGrid } from '../pure/slider.ts';
import { computeDirty as perControlDirty } from '../pure/slider.ts';
import { computePresets } from '../pure/presets.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
import { buildScalarSettings, validateSettingsPayload, computeDirty, isNoopApply, shouldShowRetryNote, applyGiveUpSummary, clampExposedRange } from '../pure/settings.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { toast } from '../components/toast.ts';
import type { RangeInfo, Capabilities, DeviceState } from '../types.ts';

// Display order only — support comes from caps.ranges, limits from the ranges.
const CONTROL_ORDER = ['gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'powerLimitW', 'tempLimitC'];
const EXPERT_CONTROLS: Array<{ key: string; label: string }> = [
  { key: 'gpuLock', label: 'GPU lock (voltage/frequency pair)' },
  { key: 'vfCurve', label: 'Custom VF curve' },
  { key: 'vramFreqOffsetGts', label: 'VRAM frequency offset' },
  { key: 'vramVoltOffsetV', label: 'VRAM voltage offset' },
];

export const APPLY_BTN_TEXT = 'Apply';

function supportedScalars(caps: Capabilities): string[] {
  return CONTROL_ORDER.filter((k) => caps.ranges[k] !== undefined);
}

export const overclockingPage: Page = {
  id: 'overclocking',

  render(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    const caps = s.caps;
    const state = s.state;
    clear(container);

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
    const values: Record<string, number> = {};
    for (const key of controls) {
      const cur = state[key as keyof DeviceState];
      values[key] = snapToRange(typeof cur === 'number' ? cur : caps.ranges[key].default, caps.ranges[key]);
    }

    const cards = new Map<string, HTMLElement>();
    const valueNodes = new Map<string, HTMLElement>();
    // Mutable current-state reference: refreshed from every apply response so
    // the "Unapplied" chips and the floating Apply never go stale (F4).
    let currentState: DeviceState = state;

    // --- floating Apply (M2b-B): bottom-left, dirty-only -------------------
    // F3 (M2C-A): while an apply is retrying, the button shows the live
    // attempt state ("Applying — retry 3/9…") and clicking it CANCELS the
    // in-flight apply — never a dead click. Progress arrives via push events
    // from main; the final result is reported honestly (give-up summary).
    const applyBtn = el('button', { class: 'btn btn-primary floating-apply', text: APPLY_BTN_TEXT });
    let applying = false;
    let unsubProgress: (() => void) | null = null;
    applyBtn.addEventListener('click', () => {
      if (applying) {
        const dev = ctx.store.get().deviceId;
        if (dev !== null) {
          void api.cancelApply(dev).catch(() => {});
          toast('info', 'Cancelling…', 'Stopping further retries — controls already applied stay applied.');
        }
        return;
      }
      void apply();
    });
    const setApplying = (on: boolean, label = APPLY_BTN_TEXT) => {
      applying = on;
      applyBtn.textContent = label;
      applyBtn.classList.toggle('applying', on);
      applyBtn.disabled = false; // always clickable: a click cancels while in flight
    };
    const updateFloating = () => {
      if (applying) return;
      applyBtn.hidden = !computeDirty(buildScalarSettings(values), currentState);
    };

    const refreshCard = (key: string) => {
      const range = caps.ranges[key];
      const value = values[key];
      const input = cards.get(key)?.querySelector<HTMLInputElement>(`input[type="range"]`);
      const fill = cards.get(key)?.querySelector<HTMLElement>('.oc-track-fill');
      const valueNode = valueNodes.get(key);
      const dirty = cards.get(key)?.querySelector<HTMLElement>('.oc-dirty');
      if (input) input.value = String(value);
      if (fill) fill.style.width = `${normalizedPosition(value, range) * 100}%`;
      if (valueNode) valueNode.textContent = formatValue(value, range.units);
      if (dirty) dirty.hidden = !perControlDirty(values, currentState, [key])[key];
      updateFloating();
    };

    const buildCard = (key: string): HTMLElement => {
      // F3 PT clamp: the temp-limit range is pinned to 90 C max (driver
      // refuses above with 0x44000005) — sliders/presets never exceed it.
      const range: RangeInfo = clampExposedRange(caps.ranges[key], key) as RangeInfo;
      const rawDriver = state[key as keyof DeviceState];
      const driverValue = typeof rawDriver === 'number' ? rawDriver : null;
      const driverText = formatDriverValue(driverValue, range);
      const offGrid = isOffGrid(driverValue, range);
      const presets = computePresets(range);

      const card = el('section', { class: 'card oc-card', dataset: { control: key } }, [
        el('div', { class: 'oc-card-head' }, [
          el('h2', { class: 'card-title', text: CONTROL_LABELS[key] ?? key }),
          el('span', { class: 'oc-driver', title: offGrid ? 'Off-grid value reported by the driver (snap applies on move)' : undefined },
            [el('span', { class: 'oc-driver-label', text: 'Driver: ' }), el('span', { text: driverText })]),
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
        el('div', { class: 'oc-meta' }, [
          el('span', { class: 'oc-range', text: `${range.min} – ${range.max} ${range.units} · step ${range.step}` }),
          el('div', { class: 'chips oc-presets' }, presets.map((p) =>
            el('button', {
              class: 'chip chip-btn',
              text: p.name,
              onClick: () => {
                values[key] = p.value;
                refreshCard(key);
              },
            }),
          )),
        ]),
        el('div', { class: 'oc-card-actions' }, [
          el('span', { class: 'oc-dirty chip chip-warn', hidden: true, text: 'Unapplied' }),
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
      cards.set(key, card);
      refreshCard(key);
      return card;
    };

    const apply = async () => {
      const live = ctx.store.get();
      const deviceId = live.deviceId;
      const caps = live.caps;
      if (deviceId === null || !caps) return;
      const settings = buildScalarSettings(values);
      if (!validateSettingsPayload(settings)) {
        toast('error', 'Apply aborted', 'The settings payload failed validation — this is a bug.');
        return;
      }
      const deviceName = caps.deviceName || 'this GPU';
      const decision = await ensureWaiver(deviceId, caps.waiverAccepted, deviceName);
      if (decision === 'cancelled') {
        toast('info', 'Apply cancelled', 'The warranty waiver must be accepted before overclocking.');
        return;
      }
      try {
        // M2b-B no-op suppression compares against the PRE-apply state: a
        // control whose value already equals the driver read-back stays
        // silent on success.
        const before = currentState;
        setApplying(true, `${APPLY_BTN_TEXT}…`);
        unsubProgress = api.onApplyProgress((p) => {
          if (p.deviceId !== deviceId) return;
          setApplying(true, `Applying — retry ${p.attempt}/${p.retryOf}…`);
        });
        const { result, state: fresh } = await api.applySettings(deviceId, settings);
        // M1 risk note: IGS may change OC state — refresh after every apply.
        currentState = fresh;
        ctx.store.set({ state: fresh });
        for (const [key, per] of Object.entries(result.perControl)) {
          const range = caps.ranges[key];
          if (!per.ok) {
            toast('error', `${CONTROL_LABELS[key] ?? key} failed`, errorMessage(per.errorCode, key));
          } else if (!isNoopApply(key, settings, before)) {
            const applied = settings[key as keyof typeof settings];
            toast('success', `${CONTROL_LABELS[key] ?? key} applied`, typeof applied === 'number' && range ? formatValue(applied, range.units) : '');
          }
          // per.ok && no-op -> silent (M2b-B): nothing changed, no toast.
        }
        if (result.cancelled) {
          // F3 abort semantics: the user stopped the retries; report the
          // honest partial state (controls already applied stay applied).
          toast('info', 'Apply cancelled', 'Controls already applied stay applied; the rest were not written.');
        } else if (shouldShowRetryNote(result)) {
          // The retry note only claims success when the retried apply
          // actually succeeded (M2b review F3): an apply that exhausted its
          // retries and failed must not show "applied on the retry attempt".
          toast('warn', 'Applied on retry', 'The driver was busy — the value was applied on the retry attempt.');
        }
        // F3 honest give-up: the driver kept refusing across the whole
        // budget — say exactly that, never a generic failure.
        const giveUp = applyGiveUpSummary(result);
        if (giveUp) toast('error', 'Apply failed', giveUp);
        // Recompute dirty chips + the floating button against the fresh
        // read-back so a control that just applied stops showing "Unapplied".
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
        toast('error', 'Apply failed', err instanceof Error ? err.message : String(err));
      } finally {
        unsubProgress?.();
        unsubProgress = null;
        setApplying(false);
      }
    };

    container.append(
      el('h1', { class: 'page-title', text: 'Overclocking' }),
      el('p', { class: 'page-subtitle', text: 'Values are clamped to the range reported by this GPU. Changes apply on demand — nothing is applied until you press Apply.' }),
      el('div', { class: 'card-stack oc-stack' }, controls.map(buildCard)),

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

      applyBtn,
    );

    updateFloating();
  },
};
