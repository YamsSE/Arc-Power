// Arc Power — Dashboard page (M2b-B redesign + M3-A + M3-C-I): device card
// (dotted driver version + registry date, Xe cores + shader units, max core
// clock + memory clock rows, no PCI ID, no capsSummary chips footer —
// M2C-B B2), the general GPU HEALTH card (five honest rows: driver
// installed, device detected, OC working, OC waiver — the ONLY persistent
// waiver display (M4-A user correction), Arc Power working — M3-C-I removed
// the "Clocks normal" row per the user's dashboard picture), and a compact
// live readout (core clock, memory clock, temp, power, fan).
//
// The page re-renders fully only when a status slot changes (boot probe,
// boot errors); telemetry ticks refresh the readout grid in place — no
// per-tick DOM churn (the decision lives in pure/status.ts::
// dashboardNeedsFullRender, unit-tested).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { healthRows, dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig, HealthRow } from '../pure/status.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { driverLine } from '../components/header.ts';
import { shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, rebarState } from '../pure/sysinfo.ts';
import type { TelemetrySample } from '../types.ts';

/** M4-D2 (§6): the "Cores / clock" bundled row's LIVE half — the current
 *  CPU frequency from the telemetry tick, ALWAYS in GHz with 1 decimal
 *  (" / @ 4.3 GHz" — the leading separator joins the static cores/threads
 *  half); null sample -> honest '—' (never a fake number). */
function liveFreqText(sample: TelemetrySample | null): string {
  const mhz = sample?.cpuFreqMhz;
  if (typeof mhz !== 'number' || !Number.isFinite(mhz)) return ' / @ — GHz';
  return ` / @ ${(mhz / 1000).toFixed(1)} GHz`;
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

/** The store slots that decide whether the dashboard must fully re-render. */
function currentSig(ctx: PageContext): DashboardSig {
  const s = ctx.store.get();
  return { health: s.health, caps: s.caps, bootError: s.bootError, driverDate: s.driverDate, sysinfo: s.sysinfo };
}

/** Last full-render signature (module state — telemetry ticks never touch it). */
let lastSig: DashboardSig | null = null;

/** One health row: dot (level-colored) + label + detail line. The M4-A
 *  "OC waiver" row is CLICKABLE while unaccepted (error level): the click
 *  opens the waiver dialog; on Accept the store caps are patched
 *  (waiverAccepted: true) and the dashboard's caps-change full re-render
 *  flips the row green IN PLACE. Accepted -> no click action. */
function healthRowEl(row: HealthRow, ctx: PageContext): HTMLElement {
  const node = el('div', { class: 'health-row', 'data-row': row.id }, [
    el('span', { class: `status-dot health-dot status-${row.level}`, title: row.detail }),
    el('span', { class: 'health-row-label', text: row.label }),
    el('span', { class: `health-row-detail text-${row.level}`, text: row.detail }),
  ]);
  if (row.id === 'waiver' && row.level === 'error') {
    node.classList.add('health-row-clickable');
    node.title = 'Warranty waiver not accepted — click to review and accept';
    node.addEventListener('click', () => void openWaiverFromRow(ctx));
  }
  return node;
}

/** M4-A: the dashboard waiver-row click -> the SAME dialog the apply paths
 *  use (ensureWaiver); on Accept, patch the store caps so the row flips
 *  green via the existing caps-change re-render. Cancel just closes. */
async function openWaiverFromRow(ctx: PageContext) {
  const live = ctx.store.get();
  if (live.deviceId === null || !live.caps || live.caps.waiverAccepted === true) return;
  const decision = await ensureWaiver(live.deviceId, false, live.caps.deviceName || 'this GPU');
  if (decision !== 'accepted') return;
  const cur = ctx.store.get();
  if (cur.caps && cur.caps.waiverAccepted !== true) {
    ctx.store.set({ caps: { ...cur.caps, waiverAccepted: true } });
  }
}

/** M3-A: the general GPU Health card (replaces the merged Service Status card). */
function healthCard(ctx: PageContext): HTMLElement {
  const s = ctx.store.get();
  const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
  const rows = healthRows({
    health: s.health,
    device,
    sample: s.latestSample,
    lastApply: s.lastApply,
    bootError: s.bootError,
    driverDate: s.driverDate,
    waiverAccepted: s.caps?.waiverAccepted ?? null,
  });

  return el('section', { class: 'card health-card' }, [
    el('h2', { class: 'card-title', text: 'GPU Health' }),
    el('div', { class: 'card-body' }, rows.map((row) => healthRowEl(row, ctx))),
  ]);
}

export const dashboardPage: Page = {
  id: 'dashboard',

  render(container: HTMLElement, ctx: PageContext) {
    lastSig = currentSig(ctx);
    const s = ctx.store.get();
    const device = s.devices.find((d) => d.id === s.deviceId) ?? null;
    // M4-D (user): the GPU-card PCIe/ReBAR rows read the sysinfo video
    // controller matched to the device (name-family match — same rules as
    // the main-side VRAM lookup; null when unmatched -> honest '—' rows).
    const matchedController = s.sysinfo?.videoControllers
      .find((c) => c.name && device?.name && c.name.replace(/\s*\d+\s*GB$/i, '') === device.name.replace(/\s*\d+\s*GB$/i, ''))
      ?? s.sysinfo?.videoControllers[0] ?? null;
    const rebar = rebarState(matchedController);
    const sysRows = cpuCardRows(s.sysinfo);

    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Dashboard' }),

      el('div', { class: 'card-grid' }, [
        // --- M4-D (user): the CPU & memory card — BEFORE the GPU card. ---
        // M4-D2 (§9): the card title is "CPU & Memory". Fed by the
        // sysinfo:get payload (CIM at boot, mock fixture in --ui-verify);
        // every field degrades honestly to '—' (pure/sysinfo.ts
        // cpuCardRows). The dashboard sig includes sysinfo, so the card
        // re-renders when the boot fetch lands after the first render.
        // M4-D2 (§6): the "Cores / clock" row's clock half is the LIVE
        // frequency (cpuFreqMhz from the telemetry tick, GHz always) — the
        // static cores/threads half comes from the sysinfo payload, the
        // live half updates IN PLACE on ticks like the GPU clocks row.
        el('section', { class: 'card sysinfo-card' }, [
          el('h2', { class: 'card-title', text: 'CPU & Memory' }),
          el('div', { class: 'card-body kv-grid' }, [
            el('div', { class: 'kv', 'data-label': 'CPU' }, [el('span', { text: sysRows.cpu })]),
            el('div', { class: 'kv', 'data-label': 'Cores / clock' }, [
              el('span', { class: 'kv-cores-clock' }, [
                el('span', { text: sysRows.coresClock }),
                el('span', { class: 'kv-live-freq', text: liveFreqText(s.latestSample) }),
              ]),
            ]),
            el('div', { class: 'kv', 'data-label': 'Memory' }, [el('span', { text: sysRows.memory })]),
          ]),
        ]),

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
                // M4-D (user): core + memory clock BUNDLED into one row —
                // "2400 MHz Core / 2187 MHz Memory" (the memory half tracks
                // the latest telemetry sample in place).
                el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', {
                  class: 'kv-clocks',
                  text: `${device.graphicsClockMHz} MHz Core / ${s.latestSample?.memClockMhz !== undefined ? s.latestSample.memClockMhz : '--'} MHz Memory`,
                })]),
                // M4-D2 (§3): the ReBAR pill is STANDALONE — no label kv row
                // around it (the "Resizable BAR" row is gone). Green "ReBAR
                // on" / red "ReBAR off" / grey "ReBAR —", data-driven from
                // the sysinfo controller's rebarActive.
                el('div', { class: 'kv kv-rebar' }, [
                  el('span', { class: `chip rebar-pill status-${rebar.level}`, text: rebar.label }),
                ]),
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
    // change) refreshes only the live readout grid in place (M3-C-I: the
    // clocks health row is gone, so no in-place health-row refresh).
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
    // M2C-B B8 (M4-D user update): the device-card COMBINED clocks row
    // tracks the latest sample in place (the card itself only re-renders
    // on status changes).
    const clocksValue = container.querySelector<HTMLElement>('.card-grid .kv[data-label="Clocks"] span');
    if (clocksValue) {
      const live = ctx.store.get();
      const dev = live.devices.find((d) => d.id === live.deviceId) ?? null;
      const mem = live.latestSample?.memClockMhz;
      const core = dev?.graphicsClockMHz;
      clocksValue.textContent = `${core !== undefined ? core : '--'} MHz Core / ${mem !== undefined ? mem : '--'} MHz Memory`;
    }
    // M4-D2 (§6): the CPU card's "Cores / clock" LIVE half (the current
    // frequency, GHz always) tracks the telemetry tick in place — same
    // pattern as the GPU clocks row.
    const liveFreq = container.querySelector<HTMLElement>('.sysinfo-card .kv-live-freq');
    if (liveFreq) liveFreq.textContent = liveFreqText(ctx.store.get().latestSample);
  },
};
