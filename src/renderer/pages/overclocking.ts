// Arc Power — Overclocking page (M2b-B UX): one card per supported control
// (slider, clamps, presets, per-card reset), Advanced disclosure for expert
// controls, and a floating Apply button anchored bottom-left that appears
// ONLY when a setting differs from the loaded driver state (dirty) and
// disappears when clean. Apply writes every dirty control with per-control
// result toasts: no-op controls (value == driver read-back before the
// apply) stay silent, errors always toast.
//
// M2C-B F3 (instant apply): ONE attempt per control, zero waiting, no
// progress UI, no cancellation, no retry note. Refusals (incl. the silent
// no-op) toast the actionable message composed in main.
//
// M2C-B B5: the "Unapplied" chip + floating Apply use the APPLIED reference
// (per-`result.ok` control -> the applied value), so they clear immediately
// even when the driver read-back lags; the no-op toast suppression still
// compares against the pre-apply driver read-back.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { snapToRange, normalizedPosition, formatValue, formatDriverValue, isOffGrid } from '../pure/slider.ts';
import { computePresets } from '../pure/presets.ts';
import { errorMessage, CONTROL_LABELS } from '../pure/errors.ts';
import { buildScalarSettings, validateSettingsPayload, isNoopApply, clampExposedRange, computeDirtyVsApplied, isScalarDirtyVsApplied, requiresExtendedRangeConfirm } from '../pure/settings.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { showExtendedRangeConfirm } from '../components/confirm-dialog.ts';
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
export const APPLY_BTN_BUSY_TEXT = 'Applying…';
// M2C-C first-apply elevation explanation: shown right before the UAC prompt
// (a short toast — the prompt itself is the OS's, this explains why).
export const ELEVATION_TOAST_TEXT = 'Administrator approval is needed to apply GPU settings.';
export const ELEVATION_CANCELED_TEXT = 'Apply requires administrator approval.';

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
    // the chips and the floating Apply never go stale.
    let currentState: DeviceState = state;
    // B5(a): the applied reference — per-`result.ok` control it becomes the
    // applied value, so the chip clears and the button hides even while the
    // driver read-back lags. Never merged with the no-op comparison (b).
    const applied: Record<string, number> = {};

    // --- floating Apply (M2b-B): bottom-left, dirty-only -------------------
    // F3 instant apply (M2C-B): one attempt, immediate result; the button is
    // just a trigger (a reentry guard swallows a double-click mid-apply).
    // M2C-C: the button shows a transient "Applying…" state while an apply
    // is pending (e.g. waiting on the UAC prompt) — disabled, no retry UI.
    const applyBtn = el('button', { class: 'btn btn-primary floating-apply', text: APPLY_BTN_TEXT });
    let applying = false;
    applyBtn.addEventListener('click', () => {
      if (applying) return;
      void apply();
    });
    const setBusy = (busy: boolean) => {
      applying = busy;
      applyBtn.disabled = busy;
      applyBtn.textContent = busy ? APPLY_BTN_BUSY_TEXT : APPLY_BTN_TEXT;
    };
    const updateFloating = () => {
      if (applying) return;
      applyBtn.hidden = !computeDirtyVsApplied(buildScalarSettings(values), currentState, applied);
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
      if (dirty) dirty.hidden = !isScalarDirtyVsApplied(key, value, currentState, applied);
      updateFloating();
    };

    const buildCard = (key: string): HTMLElement => {
      // F3 PT clamp (M2C-A) / M2C-C extended ranges: the temp-limit range is
      // pinned to 90 C max unless the device reports extended ranges (then
      // the backend already says 115 C); the power slider is pinned to 252 W
      // unless extended — sliders/presets never exceed what can be applied.
      const range: RangeInfo = clampExposedRange(caps.ranges[key], key, caps) as RangeInfo;
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
      // M2C-C: extended-range values (>252 W / >90 C) need the honest
      // confirm dialog before anything is sent. M2D: unit-aware — percent
      // featuresets never count as extended.
      if (requiresExtendedRangeConfirm(settings, caps)) {
        const confirmed = await showExtendedRangeConfirm(deviceName);
        if (!confirmed) {
          toast('info', 'Apply cancelled', 'Extended power/temperature limits were not confirmed.');
          return;
        }
      }
      // M2C-C: a non-elevated product app delegates the apply to the
      // elevated self-worker (one UAC prompt) — explain BEFORE the prompt.
      if (ctx.store.get().workerApply) {
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
        currentState = fresh;
        ctx.store.set({ state: fresh });
        // M3-A: record the outcome for the dashboard "OC working" health row
        // (honest: ok with what changed / failed with the first error).
        {
          const changed = Object.entries(result.perControl)
            .filter(([k, per]) => per.ok && !isNoopApply(k, settings, before))
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
            if (!isNoopApply(key, settings, before)) {
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

    container.append(
      el('h1', { class: 'page-title', text: 'Overclocking' }),
      el('p', {
        class: 'page-subtitle',
        text: controls.length === 0
          ? 'This GPU does not expose any overclocking controls (locked or telemetry-only).'
          : 'Values are clamped to the range reported by this GPU. Changes apply on demand — nothing is applied until you press Apply.',
      }),
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

      applyBtn,
    );

    updateFloating();
  },
};
