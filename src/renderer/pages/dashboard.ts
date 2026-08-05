// Arc Power — Dashboard page: device card, health status, live telemetry
// readouts. Rolling graphs are M2b — deliberately not built here.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { healthStatus, STATUS_LABEL } from '../components/header.ts';
import type { DeviceState, TelemetrySample } from '../types.ts';
import { formatValue } from '../pure/slider.ts';

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

export const dashboardPage: Page = {
  id: 'dashboard',

  render(container: HTMLElement, ctx: PageContext) {
    const s = ctx.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    const health = s.health;
    const status = healthStatus(health);
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
                el('span', { class: `status-dot status-${status}` }),
                el('span', { text: STATUS_LABEL[status] }),
              ]),
            ]),
            el('div', { class: 'kv', 'data-label': 'IGCL runtime' }, [el('span', { text: health?.igclLoaded ? 'Loaded' : 'Not loaded' })]),
            el('div', { class: 'kv', 'data-label': 'Level Zero' }, [el('span', { text: health?.levelZeroOk ? 'OK' : 'Failed' })]),
            health?.driverVersion ? el('div', { class: 'kv', 'data-label': 'Driver' }, [el('span', { text: health.driverVersion })]) : null,
            health?.error ? el('div', { class: 'kv', 'data-label': 'Error' }, [el('span', { class: 'text-error', text: health.error })]) : null,
          ]),
        ]),
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
    const grid = container.querySelector('#dash-readout');
    if (!grid) return;
    const tiles = statTiles(ctx.store.get().latestSample);
    grid.replaceChildren(...tiles.map((t) =>
      el('div', { class: 'stat-tile' }, [
        el('div', { class: 'stat-value', text: t.value }),
        el('div', { class: 'stat-unit', text: t.unit }),
        el('div', { class: 'stat-label', text: t.label }),
      ]),
    ));
  },
};
