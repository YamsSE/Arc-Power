// Arc Power — Dashboard page (M2b-B redesign): device card (dotted driver
// version + registry date, Xe cores + shader units, no PCI ID, no persistent
// waiver status), ONE merged Service Status card (dot + label, degraded-only
// IGCL line, half-state note, IGS toggle button), and a compact live
// readout (core clock, memory clock, temp, power, fan).
//
// The page re-renders fully only when a status slot changes (boot probe,
// IGS toggle refresh, boot errors); telemetry ticks refresh the readout grid
// in place — no per-tick DOM churn (the decision lives in
// pure/status.ts::dashboardNeedsFullRender, unit-tested).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { mapStatus, igsHalfState, IGS_NOTE, dashboardNeedsFullRender, labelForLevel } from '../pure/status.ts';
import type { DashboardSig } from '../pure/status.ts';
import { driverLine } from '../components/header.ts';
import { shaderUnits } from '../pure/driver.ts';
import { api } from '../ipc.ts';
import { toast } from '../components/toast.ts';
import type { DeviceState, IgsServiceState, TelemetrySample } from '../types.ts';
import { formatValue } from '../pure/slider.ts';

const DISABLE_BTN = 'Disable IGS service';
const REENABLE_BTN = 'Re-enable IGS service';

function capsSummary(state: DeviceState): string[] {
  const out: string[] = [];
  if (state.powerLimitW !== null) out.push(`Power limit ${state.powerLimitW} W`);
  if (state.gpuVoltOffsetV !== null) out.push(`Voltage offset ${formatValue(state.gpuVoltOffsetV, 'V')}`);
  if (state.gpuFreqOffsetMhz !== null) out.push(`Core offset ${state.gpuFreqOffsetMhz} MHz`);
  if (state.tempLimitC !== null) out.push(`Temp limit ${state.tempLimitC} °C`);
  if (state.fanCurve) out.push(`Fan curve ${state.fanCurve.length} points`);
  return out;
}

function statTiles(sample: TelemetrySample | null): Array<{ label: string; value: string; unit: string }> {
  const clock = sample?.gpuClockMhz;
  const memClock = sample?.memClockMhz;
  const temp = sample?.tempC;
  const power = sample?.powerW;
  const rpm = sample?.fanRpm?.[0];
  return [
    { label: 'Core clock', value: clock !== undefined ? String(Math.round(clock)) : '—', unit: 'MHz' },
    { label: 'Memory clock', value: memClock !== undefined ? String(Math.round(memClock)) : '—', unit: 'MHz' },
    { label: 'Temperature', value: temp !== undefined ? String(Math.round(temp)) : '—', unit: '°C' },
    { label: 'Power draw', value: power !== undefined ? power.toFixed(1) : '—', unit: 'W' },
    { label: 'Fan speed', value: rpm !== undefined ? String(Math.round(rpm)) : '—', unit: 'RPM' },
  ];
}

function igsStateText(igs: IgsServiceState | null): string {
  if (!igs?.service.found) return 'not detected';
  const svc = igs.service;
  return `${svc.running ? 'running' : 'stopped'} (${svc.startType}) · app ${igs.appRunning ? 'running' : 'not running'}`;
}

/** The store slots that decide whether the dashboard must fully re-render. */
function currentSig(ctx: PageContext): DashboardSig {
  const s = ctx.store.get();
  return { igsState: s.igsState, health: s.health, caps: s.caps, bootError: s.bootError, driverDate: s.driverDate };
}

/** Last full-render signature (module state — telemetry ticks never touch it). */
let lastSig: DashboardSig | null = null;

/**
 * Toggle the IGS service (disable when running, enable when stopped). The
 * real action runs elevated (UAC) — this is the ONLY trigger, a user click.
 * Afterwards refresh the IGS state + health/caps so the status indicator and
 * the card update.
 */
async function runIgsToggle(ctx: PageContext): Promise<void> {
  const s = ctx.store.get();
  const igs = s.igsState;
  if (!igs?.service.found) return;
  const disable = igs.service.running;
  const result = disable ? await api.disableIgsService() : await api.enableIgsService();
  toast(
    result.ok ? 'success' : 'error',
    result.ok
      ? (disable ? 'IGS service disabled' : 'IGS service enabled')
      : (disable ? 'Failed to disable IGS service' : 'Failed to enable IGS service'),
    result.error ?? '',
  );
  try { ctx.store.set({ igsState: await api.getIgsServiceState() }); } catch { /* probe failure keeps the stale state */ }
  try { ctx.store.set({ health: await api.health() }); } catch { /* keep the current health */ }
  if (s.deviceId !== null) {
    try { ctx.store.set({ caps: await api.getCapabilities(s.deviceId) }); } catch { /* keep the current caps */ }
  }
  const container = document.getElementById('page') as HTMLElement;
  dashboardPage.render(container, ctx);
}

/**
 * The merged "Service Status" card (M2b-B): dot + label, IGCL health shown
 * only when degraded, the half-state warning only when actually half-state,
 * the IGS toggle button. Driver version and Level Zero are gone.
 */
function statusCard(ctx: PageContext): HTMLElement {
  const s = ctx.store.get();
  const health = s.health;
  const igs = s.igsState;
  // Half-state = the verified OC blocker: service and app disagree (NOT gated
  // on service.found — a failed probe with the app running still blocks OC
  // writes; the note must agree with the header warning). Fully-on and
  // fully-off both accept OC writes — no warning note.
  const halfState = igsHalfState(igs);
  const svcRunning = igs?.service.running === true;
  const igclDegraded = !health?.igclLoaded || !health?.levelZeroOk;
  const { level, label } = mapStatus(health, igs);
  // NIT 3: the verbose label renders only for warning/degraded/error — the
  // fully-on/off (and searching) states show just the dot; the label moves
  // to the dot tooltip (same convention as the header indicator).
  const visibleLabel = labelForLevel(level);

  return el('section', { class: 'card status-card' }, [
    el('h2', { class: 'card-title', text: 'Service Status' }),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'kv-status' }, [
        el('span', { class: `status-dot status-${level}`, title: label }),
        visibleLabel !== null ? el('span', { class: 'status-label', text: visibleLabel }) : null,
      ]),
      // IGCL detail line ONLY when degraded (healthy = no detail noise).
      igclDegraded
        ? el('div', { class: 'kv', 'data-label': 'IGCL runtime' }, [
            el('span', { class: 'text-error', text: health?.error ?? 'Not loaded' }),
          ])
        : null,
      health?.error && !igclDegraded
        ? el('div', { class: 'kv', 'data-label': 'Backend' }, [el('span', { class: 'text-error', text: health.error })])
        : null,
    ]),
    halfState
      ? el('p', { class: 'card-note igs-note', text: IGS_NOTE })
      : null,
    igs?.service.found
      ? el('div', { class: 'card-footer' }, [
          el('button', {
            class: svcRunning ? 'btn btn-danger btn-sm igs-toggle' : 'btn btn-sm igs-toggle',
            text: svcRunning ? DISABLE_BTN : REENABLE_BTN,
            title: igsStateText(igs),
            onClick: (ev: Event) => {
              (ev.currentTarget as HTMLButtonElement).disabled = true;
              void runIgsToggle(ctx);
            },
          }),
        ])
      : null,
  ]);
}

export const dashboardPage: Page = {
  id: 'dashboard',

  render(container: HTMLElement, ctx: PageContext) {
    lastSig = currentSig(ctx);
    const s = ctx.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    const state = s.state;

    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Dashboard' }),

      el('div', { class: 'card-grid' }, [
        // --- device card ---
        el('section', { class: 'card' }, [
          el('h2', { class: 'card-title', text: device?.name ?? 'No GPU detected' }),
          device
            ? el('div', { class: 'card-body kv-grid' }, [
                el('div', { class: 'kv', 'data-label': 'Driver version' }, [el('span', { text: driverLine(device, s.driverDate) ?? device.driverVersion })]),
                // M2b-B: no PCI ID, no persistent waiver status.
                device.numXeCores > 0
                  ? el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', { text: `Xe Cores ${device.numXeCores} - Shader Units ${shaderUnits(device.numXeCores)}` })])
                  : null,
                el('div', { class: 'kv', 'data-label': 'Graphics clock' }, [el('span', { text: `${device.graphicsClockMHz} MHz` })]),
              ])
            : el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' }),
          state
            ? el('div', { class: 'card-footer chips' }, capsSummary(state).map((t) => el('span', { class: 'chip', text: t })))
            : null,
        ]),

        // --- merged Service Status card (health + IGS in one) ---
        statusCard(ctx),
      ]),

      // --- live readout (compact, M2b-B) ---
      el('section', { class: 'card readout-card' }, [
        el('h2', { class: 'card-title', text: 'Live readout' }),
        el('div', { class: 'readout-grid', id: 'dash-readout' }, statTiles(s.latestSample).map((t) =>
          el('div', { class: 'stat-tile' }, [
            el('div', { class: 'stat-value', text: t.value }),
            el('div', { class: 'stat-unit', text: t.unit }),
            el('div', { class: 'stat-label', text: t.label }),
          ]),
        )),
      ]),
    );
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // Full re-render only when a status slot changed (boot probe, IGS toggle
    // refresh, boot errors) — NOT on telemetry ticks. A tick (or any other
    // non-status change) refreshes only the live readout grid in place.
    const sig = currentSig(ctx);
    if (dashboardNeedsFullRender(lastSig, sig)) {
      lastSig = sig;
      dashboardPage.render(container, ctx);
      return;
    }
    const grid = container.querySelector<HTMLElement>('#dash-readout');
    if (grid) {
      clear(grid);
      grid.append(
        ...statTiles(ctx.store.get().latestSample).map((t) =>
          el('div', { class: 'stat-tile' }, [
            el('div', { class: 'stat-value', text: t.value }),
            el('div', { class: 'stat-unit', text: t.unit }),
            el('div', { class: 'stat-label', text: t.label }),
          ]),
        ),
      );
    }
  },
};
