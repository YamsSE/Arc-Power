// Arc Power — Dashboard page: device card, health status, IGS service status,
// live telemetry readouts. Rolling graphs are M2b — deliberately not built
// here.
//
// The page re-renders fully only when a status slot changes (boot probe,
// IGS toggle refresh, boot errors); telemetry ticks refresh the readout grid
// in place — no per-tick DOM churn (the decision lives in
// pure/status.ts::dashboardNeedsFullRender, unit-tested).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { mapStatus, igsHalfState, IGS_NOTE, dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig } from '../pure/status.ts';
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
  if (state.gpuFreqOffsetMhz !== null) out.push(`Frequency offset ${state.gpuFreqOffsetMhz} MHz`);
  if (state.tempLimitC !== null) out.push(`Temp limit ${state.tempLimitC} °C`);
  if (state.fanCurve) out.push(`Fan curve ${state.fanCurve.length} points`);
  return out;
}

function statTiles(sample: TelemetrySample | null): Array<{ label: string; value: string; unit: string }> {
  const clock = sample?.gpuClockMhz;
  const temp = sample?.tempC;
  const power = sample?.powerW;
  const rpm = sample?.fanRpm?.[0];
  return [
    { label: 'GPU clock', value: clock !== undefined ? String(Math.round(clock)) : '—', unit: 'MHz' },
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
  return { igsState: s.igsState, health: s.health, caps: s.caps, bootError: s.bootError };
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

function igsCard(ctx: PageContext): HTMLElement {
  const igs = ctx.store.get().igsState;
  // Half-state = the verified OC blocker: service and app disagree (NOT gated
  // on service.found — a failed probe with the app running still blocks OC
  // writes; the note must agree with the header warning). Fully-on and
  // fully-off both accept OC writes — no warning note.
  const halfState = igsHalfState(igs);
  const svcRunning = igs?.service.running === true;
  return el('section', { class: 'card' }, [
    el('h2', { class: 'card-title', text: 'System status' }),
    el('div', { class: 'card-body kv-grid' }, [
      el('div', { class: 'kv', 'data-label': 'IGS service' }, [
        el('span', { text: igsStateText(igs) }),
      ]),
    ]),
    halfState
      ? el('p', { class: 'card-note igs-note', text: IGS_NOTE })
      : null,
    igs?.service.found
      ? el('div', { class: 'card-footer' }, [
          el('button', {
            class: svcRunning ? 'btn btn-danger igs-toggle' : 'btn igs-toggle',
            text: svcRunning ? DISABLE_BTN : REENABLE_BTN,
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
    const health = s.health;
    const { level, label } = mapStatus(health, s.igsState);
    const caps = s.caps;
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
                el('div', { class: 'kv', 'data-label': 'Driver version' }, [el('span', { text: device.driverVersion })]),
                el('div', { class: 'kv', 'data-label': 'PCI ID' }, [el('span', { text: `${device.pciVendorId}:${device.pciDeviceId}` })]),
                el('div', { class: 'kv', 'data-label': 'Xe cores' }, [el('span', { text: String(device.numXeCores) })]),
                el('div', { class: 'kv', 'data-label': 'Graphics clock' }, [el('span', { text: `${device.graphicsClockMHz} MHz` })]),
                el('div', { class: 'kv', 'data-label': 'OC waiver' }, [
                  el('span', { text: caps?.waiverAccepted ? 'Accepted' : 'Not accepted' }),
                ]),
              ])
            : el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' }),
          state
            ? el('div', { class: 'card-footer chips' }, capsSummary(state).map((t) => el('span', { class: 'chip', text: t })))
            : null,
        ]),

        // --- health card ---
        el('section', { class: 'card' }, [
          el('h2', { class: 'card-title', text: 'Service health' }),
          el('div', { class: 'card-body kv-grid' }, [
            el('div', { class: 'kv', 'data-label': 'Status' }, [
              el('span', { class: 'kv-status' }, [
                el('span', { class: `status-dot status-${level}` }),
                el('span', { text: label }),
              ]),
            ]),
            el('div', { class: 'kv', 'data-label': 'IGCL runtime' }, [el('span', { text: health?.igclLoaded ? 'Loaded' : 'Not loaded' })]),
            el('div', { class: 'kv', 'data-label': 'Level Zero' }, [el('span', { text: health?.levelZeroOk ? 'OK' : 'Failed' })]),
            health?.driverVersion ? el('div', { class: 'kv', 'data-label': 'Driver' }, [el('span', { text: health.driverVersion })]) : null,
            health?.error ? el('div', { class: 'kv', 'data-label': 'Error' }, [el('span', { class: 'text-error', text: health.error })]) : null,
          ]),
        ]),

        // --- IGS service card ---
        igsCard(ctx),
      ]),

      // --- live readout ---
      el('section', { class: 'card readout-card' }, [
        el('h2', { class: 'card-title', text: 'Live readout' }),
        el('div', { class: 'readout-grid', id: 'dash-readout' }, statTiles(s.latestSample).map((t) =>
          el('div', { class: 'stat-tile' }, [
            el('div', { class: 'stat-value', text: t.value }),
            el('div', { class: 'stat-unit', text: t.unit }),
            el('div', { class: 'stat-label', text: t.label }),
          ]),
        )),
        el('p', { class: 'card-note', text: 'Rolling graphs arrive in M2b.' }),
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
