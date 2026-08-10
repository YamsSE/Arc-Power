// Arc Power - Dashboard page (M2b-B redesign + M3-A + M3-C-I): GPU card
// (M4-H: title 'GPU' + a 'GPU' name kv row - the Driver version row moved
// OUT (the health card keeps it); Xe cores + shader units, bundled clocks
// row, standalone ReBAR pill - M2C-B B2), the general GPU HEALTH card (five
// honest rows: driver installed, device detected, OC working, OC waiver -
// the ONLY persistent waiver display (M4-A correction), Arc Power
// working), the CPU & Memory card (M4-D2 - M4-H: DDR5 memory type + the
// blue .kv-static-freq GHz speed span + the M4J Mainboard row), and a
// compact live readout (M4-H: TWO labeled groups - CPU above GPU, both
// refreshing in place on ticks).
//
// The page re-renders fully only when a status slot changes (boot probe,
// boot errors); telemetry ticks refresh the readout grids in place - no
// per-tick DOM churn (the decision lives in pure/status.ts::
// dashboardNeedsFullRender, unit-tested).

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { healthRows, dashboardNeedsFullRender } from '../pure/status.ts';
import type { DashboardSig, HealthRow } from '../pure/status.ts';
import { ensureWaiver } from '../components/waiver-dialog.ts';
import { buildDeviceSelect } from '../components/device-select.ts';
import { selectDevice } from '../app.ts';
import { shaderUnits } from '../pure/driver.ts';
import { cpuCardRows, rebarState, vramRowValue, ghzFreq } from '../pure/sysinfo.ts';
import { stripVramSuffix } from '../pure/device.ts';
import type { TelemetrySample } from '../types.ts';

/** M4-D2 (§6): the "Cores / clock" bundled row's LIVE half - the current
 *  CPU frequency from the telemetry tick, ALWAYS in GHz with 1 decimal
 *  (" / @ 4.3 GHz" - the leading separator joins the static cores/threads
 *  half); null sample -> honest '-' (never a fake number). */
function liveFreqText(sample: TelemetrySample | null): string {
  const mhz = sample?.cpuFreqMhz;
  if (typeof mhz !== 'number' || !Number.isFinite(mhz)) return ' / @ - GHz';
  return ` / @ ${(mhz / 1000).toFixed(1)} GHz`;
}

function statTileNode(t: { label: string; value: string; unit: string }): HTMLElement {
  return el('div', { class: 'stat-tile' }, [
    el('div', { class: 'stat-value', text: t.value }),
    el('div', { class: 'stat-unit', text: t.unit }),
    el('div', { class: 'stat-label', text: t.label }),
  ]);
}

function statValue(v: number | null | undefined, decimals = 0): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '-' : decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
}

/** M4-H (C3)/M4M (D)/M4N (A): the CPU group of the live readout - Util
 *  FIRST (the planned order), then Core Frequency (M4N: GHz - the shared
 *  ghzFreq helper, the mock's 4300 MHz reads '4.3'), Temperature and the
 *  Power tile (M4N: renamed from Wattage; cpuPowerW from the PowerMeter
 *  counter - the class is often absent on desktops -> honest '-'). */
function cpuStatTiles(sample: TelemetrySample | null): Array<{ label: string; value: string; unit: string }> {
  return [
    { label: 'Util', value: statValue(sample?.cpuUtilPct), unit: '%' },
    { label: 'Core Frequency', value: ghzFreq(sample?.cpuFreqMhz), unit: 'GHz' },
    { label: 'Temperature', value: statValue(sample?.cpuTempC), unit: '°C' },
    { label: 'Power', value: statValue(sample?.cpuPowerW, 1), unit: 'W' },
  ];
}

/** M4-H (C3)/M4M (D)/M4N (A): the GPU group of the live readout - Util FIRST,
 *  then the classic five tiles. M4-I (D4): the Util tile reads
 *  `gpuUtilPct ?? utilPct` - on no-Intel the OS GPUEngine counter is the
 *  only source; on Intel the IGCL activity counter wins when the OS
 *  counter is unpopulated. M4N: the Power tile is renamed from 'Power
 *  draw' (the monitoring label match). */
function gpuStatTiles(sample: TelemetrySample | null): Array<{ label: string; value: string; unit: string }> {
  return [
    { label: 'Util', value: statValue(sample?.gpuUtilPct ?? sample?.utilPct), unit: '%' },
    { label: 'Core clock', value: statValue(sample?.gpuClockMhz), unit: 'MHz' },
    { label: 'Memory clock', value: statValue(sample?.memClockMhz), unit: 'MHz' },
    { label: 'Temperature', value: statValue(sample?.tempC), unit: '°C' },
    { label: 'Power', value: statValue(sample?.powerW, 1), unit: 'W' },
    { label: 'Fan speed', value: statValue(sample?.fanRpm?.[0]), unit: 'RPM' },
  ];
}

/** The store slots that decide whether the dashboard must fully re-render. */
function currentSig(ctx: PageContext): DashboardSig {
  const s = ctx.store.get();
  return {
    health: s.health,
    caps: s.caps,
    bootError: s.bootError,
    driverDate: s.driverDate,
    sysinfo: s.sysinfo,
    noIntel: s.noIntel,
    osGpu: s.osGpu,
    // M4N (A.1): the boot-apply outcome lands via the boot fetch - it is
    // part of the signature so the OC Status row flips green on arrival.
    lastApply: s.lastApply,
  };
}

/** Last full-render signature (module state - telemetry ticks never touch it). */
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
    node.title = 'Warranty waiver not accepted - click to review and accept';
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
    // 1.0.1 no-Intel round: the rows swap to the honest no-Intel texts on
    // the no-device path ('No Intel Driver Found' / the OS GPU name).
    hasIntelGpu: s.noIntel !== true,
    osGpuName: s.osGpu?.name ?? null,
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
    // M4-D: the GPU-card PCIe/ReBAR rows read the sysinfo video
    // controller matched to the device (name-family match - same rules as
    // the main-side VRAM lookup; null when unmatched -> honest '-' rows).
    const matchedController = s.sysinfo?.videoControllers
      .find((c) => c.name && device?.name && stripVramSuffix(c.name) === stripVramSuffix(device.name))
      ?? s.sysinfo?.videoControllers[0] ?? null;
    // M4-I (D3): the no-Intel branch's controller - the OS GPU's own sysinfo
    // row (the OS pnputil/allocated ReBAR sources are GPU-agnostic, so the
    // verdict is REAL there too; the Driver version row + the VRAM row read
    // it as well).
    const osController = s.sysinfo?.videoControllers
      .find((c) => c.name && s.osGpu?.name && c.name === s.osGpu.name)
      ?? s.sysinfo?.videoControllers[0] ?? null;
    const rebar = rebarState(matchedController);
    const osRebar = rebarState(osController);
    const sysRows = cpuCardRows(s.sysinfo);

    clear(container);
    container.append(
      el('h1', { class: 'page-title', text: 'Dashboard' }),

      el('div', { class: 'card-grid' }, [
        // --- M4-D: the CPU & memory card - BEFORE the GPU card. ---
        // M4-D2 (§9): the card title is "CPU & Memory". Fed by the
        // sysinfo:get payload (CIM at boot, mock fixture in --ui-verify);
        // every field degrades honestly to '-' (pure/sysinfo.ts
        // cpuCardRows). The dashboard sig includes sysinfo, so the card
        // re-renders when the boot fetch lands after the first render.
        // M4-D2 (§6): the "Cores / clock" row's clock half is the LIVE
        // frequency (cpuFreqMhz from the telemetry tick, GHz always) - the
        // static cores/threads half comes from the sysinfo payload, the
        // live half updates IN PLACE on ticks like the GPU clocks row.
        el('section', { class: 'card sysinfo-card' }, [
          el('h2', { class: 'card-title', text: 'CPU & Memory' }),
          el('div', { class: 'card-body kv-grid' }, [
            el('div', { class: 'kv', 'data-label': 'CPU' }, [el('span', { text: sysRows.cpu })]),
            // M4-I (A3): the label is 'Cores / Clock' (the data-label
            // queries in BOTH verify variants follow).
            el('div', { class: 'kv', 'data-label': 'Cores / Clock' }, [
              el('span', { class: 'kv-cores-clock' }, [
                el('span', { text: sysRows.coresClock }),
                el('span', { class: 'kv-live-freq', text: liveFreqText(s.latestSample) }),
              ]),
            ]),
            // M4-H (C2)/M4J (B)/M4L (A): the Memory row gains the RAM TYPE
            // (DDR5 from Win32_PhysicalMemory.SMBIOSMemoryType via the pure
            // mapping) and the speed half renders in its OWN
            // .kv-static-freq span (sharing the kv-live-freq rule - never
            // that class itself, the onUpdate first-match hazard - N3).
            // M4J: the speed was ALWAYS GHz ("@ 6.0 GHz" - one decimal);
            // M4L: INVERTED back to MHz ("@ 6000 MHz", the '@ ' prefix
            // kept). M4L (F1 grid fix): BOTH spans live inside ONE
            // .kv-memory container span (the .kv-cores-clock precedent) -
            // two sibling spans inside .kv (display:contents) let
            // auto-placement drop the .kv-static-freq span into the NEXT
            // row's label column (the orphan line + the scrambled
            // Mainboard row); .kv-memory { white-space: nowrap } keeps the
            // row on one line.
            el('div', { class: 'kv', 'data-label': 'Memory' }, [
              el('span', { class: 'kv-memory' }, [
                el('span', { text: sysRows.memoryFreq ? `${sysRows.memory} ` : sysRows.memory }),
                ...(sysRows.memoryFreq ? [el('span', { class: 'kv-static-freq', text: sysRows.memoryFreq })] : []),
              ]),
            ]),
            // M4J (B): the 'Mainboard' row replaces the M4-I 'Cache' row -
            // Win32_BaseBoard Manufacturer + Product via the short-map
            // ("ASUSTeK MAXIMUS VII RANGER"); the Product alone when the
            // manufacturer is unknown; '-' when neither.
            el('div', { class: 'kv', 'data-label': 'Mainboard' }, [el('span', { text: sysRows.mainboard })]),
          ]),
        ]),

        // --- device card ---
        // M4-F: the card header row carries the compact GPU selector (hidden
        // with <= 1 device - the honest single-device degradation).
        // M4-H (C1): the card title is "GPU" and the device name moved to a
        // kv row under it (the CPU card's layout mirrored: title, then the
        // 'CPU' kv row - the GPU card is title 'GPU' + a 'GPU' kv row). The
        // Driver version row is REMOVED from this card (the health card
        // keeps it - N7: the no-Intel branch gets the SAME restructure).
        // ReBAR pill, Compute, Clocks rows stay.
        el('section', { class: 'card device-card' }, [
          el('div', { class: 'device-card-head' }, [
            el('h2', { class: 'card-title', text: 'GPU' }),
            buildDeviceSelect(ctx.store, (id) => void selectDevice(id)),
          ]),
          ...(s.noIntel
            ? [
                // M4-I (D3): the no-Intel branch renders the REAL rows the
                // OS has: Driver version (the NEW videoControllers
                // driverVersion field - works on any GPU), Compute '-',
                // Clocks '- MHz Core / - MHz Memory' (honest - no OS clock
                // source on any GPU), VRAM (size + type-when-known - the
                // type table is Intel-only, so an AMD part shows the size
                // only), ReBAR pill REAL (the OS pnputil/allocated sources
                // are GPU-agnostic). The 'Non supported GPU' note stays.
                // NOTE: this REVERSES the M4-H pin that asserted the driver
                // row's ABSENCE (ui-verify.js ~3852) - the inversion is
                // explicit.
                el('div', { class: 'card-body kv-grid' }, [
                  el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: s.osGpu?.name ?? '-' })]),
                  el('div', { class: 'kv', 'data-label': 'Driver version' }, [el('span', { text: osController?.driverVersion ?? '-' })]),
                  el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', { text: '-' })]),
                  el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', { text: '- MHz Core / - MHz Memory' })]),
                  el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { text: vramRowValue(s.osGpu?.vramBytes, null) })]),
                  el('div', { class: 'kv kv-rebar' }, [
                    el('span', { class: `chip rebar-pill status-${osRebar.level}`, text: osRebar.label }),
                  ]),
                ]),
                el('p', { class: 'card-note', text: 'Non supported GPU - overclocking requires an Intel Arc GPU; this state is permanent on non-Intel machines.' }),
              ]
            : device
              ? [el('div', { class: 'card-body kv-grid' }, [
                el('div', { class: 'kv', 'data-label': 'GPU' }, [el('span', { text: device.name })]),
                // M2b-B: no PCI ID, no persistent waiver status.
                device.numXeCores > 0
                  ? el('div', { class: 'kv', 'data-label': 'Compute' }, [el('span', { text: `Xe Cores ${device.numXeCores} - Shader Units ${shaderUnits(device.numXeCores)}` })])
                  : null,
                // M4-D: core + memory clock BUNDLED into one row -
                // "2400 MHz Core / 2187 MHz Memory" (the memory half tracks
                // the latest telemetry sample in place).
                el('div', { class: 'kv', 'data-label': 'Clocks' }, [el('span', {
                  class: 'kv-clocks',
                  text: `${device.graphicsClockMHz} MHz Core / ${s.latestSample?.memClockMhz !== undefined ? s.latestSample.memClockMhz : '--'} MHz Memory`,
                })]),
                // M4-I (B2): the VRAM row below the Shader info - the same
                // ceil contract as formatDeviceName with the memType CARRIED
                // ON THE DEVICE PAYLOAD (no renderer-side table).
                el('div', { class: 'kv', 'data-label': 'VRAM' }, [el('span', { text: vramRowValue(device.vramBytes, device.memType) })]),
                // M4-D2 (§3): the ReBAR pill is STANDALONE - no label kv row
                // around it (the "Resizable BAR" row is gone). Green "ReBAR
                // on" / red "ReBAR off" / grey "ReBAR -", data-driven from
                // the sysinfo controller's rebarActive.
                el('div', { class: 'kv kv-rebar' }, [
                  el('span', { class: `chip rebar-pill status-${rebar.level}`, text: rebar.label }),
                ]),
              ])]
            : [el('div', { class: 'card-body', text: s.bootError ?? 'Searching for a graphics device…' })]),
        ]),

        // --- M3-A: the general GPU Health card (was the Service Status card) ---
        healthCard(ctx),
      ]),

      // --- live readout (compact, M2b-B) ---
      // M4-H (C3): TWO labeled groups - CPU ABOVE GPU - each with its own
      // grid. Both refresh IN PLACE on ticks (the onUpdate pattern).
      el('section', { class: 'card readout-card' }, [
        el('h2', { class: 'card-title', text: 'Live readout' }),
        el('div', { class: 'readout-group' }, [
          el('div', { class: 'readout-group-label', text: 'CPU' }),
          el('div', { class: 'readout-grid', id: 'dash-readout-cpu' }, cpuStatTiles(s.latestSample).map(statTileNode)),
        ]),
        el('div', { class: 'readout-group' }, [
          el('div', { class: 'readout-group-label', text: 'GPU' }),
          el('div', { class: 'readout-grid', id: 'dash-readout-gpu' }, gpuStatTiles(s.latestSample).map(statTileNode)),
        ]),
      ]),
    );
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    // Full re-render only when a status slot changed (boot probe, boot
    // errors) - NOT on telemetry ticks. A tick (or any other non-status
    // change) refreshes only the live readout grids in place (M3-C-I: the
    // clocks health row is gone, so no in-place health-row refresh).
    const sig = currentSig(ctx);
    if (dashboardNeedsFullRender(lastSig, sig)) {
      lastSig = sig;
      dashboardPage.render(container, ctx);
      return;
    }
    // M4-H (C3): both group grids refresh in place (the tile lookups are
    // scoped to the group containers - both groups carry Temperature/Util-
    // like labels, N8).
    for (const [id, tiles] of [['dash-readout-cpu', cpuStatTiles(ctx.store.get().latestSample)], ['dash-readout-gpu', gpuStatTiles(ctx.store.get().latestSample)]] as Array<[string, Array<{ label: string; value: string; unit: string }>]>) {
      const grid = container.querySelector<HTMLElement>(`#${id}`);
      if (grid) {
        clear(grid);
        grid.append(...tiles.map(statTileNode));
      }
    }
    // M2C-B B8 (M4-D update): the device-card COMBINED clocks row
    // tracks the latest sample in place (the card itself only re-renders
    // on status changes). 1.0.1 no-Intel round: skipped on the no-device
    // path - the row is the static honest '-' (no IGCL device to track).
    const clocksValue = container.querySelector<HTMLElement>('.card-grid .kv[data-label="Clocks"] span');
    if (clocksValue && !ctx.store.get().noIntel) {
      const live = ctx.store.get();
      const dev = live.devices.find((d) => d.id === live.deviceId) ?? null;
      const mem = live.latestSample?.memClockMhz;
      const core = dev?.graphicsClockMHz;
      clocksValue.textContent = `${core !== undefined ? core : '--'} MHz Core / ${mem !== undefined ? mem : '--'} MHz Memory`;
    }
    // M4-D2 (§6): the CPU card's "Cores / clock" LIVE half (the current
    // frequency, GHz always) tracks the telemetry tick in place - same
    // pattern as the GPU clocks row.
    const liveFreq = container.querySelector<HTMLElement>('.sysinfo-card .kv-live-freq');
    if (liveFreq) liveFreq.textContent = liveFreqText(ctx.store.get().latestSample);
  },
};
