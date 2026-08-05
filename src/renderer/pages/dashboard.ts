// Arc Power — Dashboard page (M2b-B redesign + M3-A): device card (dotted
// driver version + registry date, Xe cores + shader units, max core clock +
// memory clock rows, no PCI ID, no persistent waiver status, no capsSummary
// chips footer — M2C-B B2), the general GPU HEALTH card (five honest rows:
// driver installed, device detected, clocks normal, OC working, Arc Power
// working — the M3-A replacement for the merged Service Status card, which
// is gone: IGS is no longer a status item), and a compact live readout
// (core clock, memory clock, temp, power, fan).
//
// The page re-renders fully only when a status slot changes (boot probe,
// boot errors); telemetry ticks refresh the readout grid + the health card's
// clocks row in place — no per-tick DOM churn (the decision lives in
// pure/status.ts::dashboardNeedsFullRender, unit-tested).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { healthRows, dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig, HealthRow } from '../pure/status.ts';
import { driverLine } from '../components/header.ts';
import { shaderUnits } from '../pure/driver.ts';
import type { TelemetrySample } from '../types.ts';

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

/** The store slots that decide whether the dashboard must fully re-render. */
function currentSig(ctx: PageContext): DashboardSig {
  const s = ctx.store.get();
  return { health: s.health, caps: s.caps, bootError: s.bootError, driverDate: s.driverDate };
}

/** Last full-render signature (module state — telemetry ticks never touch it). */
let lastSig: DashboardSig | null = null;

/** One health row: dot (level-colored) + label + detail line. */
function healthRowEl(row: HealthRow): HTMLElement {
  return el('div', { class: `health-row`, 'data-row': row.id }, [
    el('span', { class: `status-dot health-dot status-${row.level}`, title: row.detail }),
    el('span', { class: 'health-row-label', text: row.label }),
    el('span', { class: `health-row-detail text-${row.level}`, text: row.detail }),
  ]);
}

/** M3-A: the general GPU Health card (replaces the merged Service Status card). */
function healthCard(ctx: PageContext): HTMLElement {
  const s = ctx.store.get();
  const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
  const rows = healthRows({ health: s.health, device, sample: s.latestSample, lastApply: s.lastApply, bootError: s.bootError });

  return el('section', { class: 'card health-card' }, [
    el('h2', { class: 'card-title', text: 'GPU Health' }),
    el('div', { class: 'card-body' }, rows.map(healthRowEl)),
  ]);
}

/**
 * Refresh the health card's clocks row in place (telemetry tick — NOT a full
 * re-render). The row's `data-row="clocks"` cell carries the live sample.
 */
function refreshClocksRow(container: HTMLElement, ctx: PageContext): void {
  const row = container.querySelector<HTMLElement>('.health-card .health-row[data-row="clocks"]');
  if (!row) return;
  const s = ctx.store.get();
  const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
  const next = healthRows({ health: s.health, device, sample: s.latestSample, lastApply: s.lastApply, bootError: s.bootError })
    .find((r) => r.id === 'clocks');
  if (!next) return;
  const dot = row.querySelector<HTMLElement>('.health-dot');
  if (dot) {
    dot.className = `status-dot health-dot status-${next.level}`;
    dot.title = next.detail;
  }
  const detail = row.querySelector<HTMLElement>('.health-row-detail');
  if (detail) {
    detail.className = `health-row-detail text-${next.level}`;
    detail.textContent = next.detail;
  }
}

export const dashboardPage: Page = {
  id: 'dashboard',

  render(container: HTMLElement, ctx: PageContext) {
    lastSig = currentSig(ctx);
    const s = ctx.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;

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
                // M2C-B B8: memory clock from the latest telemetry sample
                // ('--' until the first sample arrives; the card re-renders
                // on status changes — acceptable).
                el('div', { class: 'kv', 'data-label': 'Memory clock' }, [el('span', { text: `${s.latestSample?.memClockMhz !== undefined ? s.latestSample.memClockMhz : '--'} MHz` })]),
              ])
            : el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' }),
        ]),

        // --- M3-A: the general GPU Health card (was the Service Status card) ---
        healthCard(ctx),
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
    // Full re-render only when a status slot changed (boot probe, boot
    // errors) — NOT on telemetry ticks. A tick (or any other non-status
    // change) refreshes only the live readout grid + the clocks row in place.
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
    // M2C-B B8: the device-card memory clock row tracks the latest sample
    // in place (the card itself only re-renders on status changes).
    const memValue = container.querySelector<HTMLElement>('.card-grid .kv[data-label="Memory clock"] span');
    if (memValue) {
      const mem = ctx.store.get().latestSample?.memClockMhz;
      memValue.textContent = `${mem !== undefined ? mem : '--'} MHz`;
    }
    // M3-A: the health card's clocks row tracks the latest sample in place.
    refreshClocksRow(container, ctx);
  },
};
