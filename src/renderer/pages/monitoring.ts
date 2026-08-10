// Arc Power - Monitoring page (M2b-B): live readout grid fed by the
// telemetry IPC push + one rolling Canvas graph per segment (core clock,
// temperature, power, utilization, fan) with a 60 s window. Each segment is
// COLLAPSIBLE (header row + chevron; collapsed by default except the first).
// FPS comes from the fps-poll IPC channel (the DXGI frame-statistics /
// output-duplication adapter); when no frame statistics are being reported
// the page shows "FPS unavailable" gracefully - never an error.
//
// M4M (B): the live readout is TWO labeled groups like the dashboard - the
// CPU group (the dashboard CPU tiles verbatim) ABOVE the GPU group (the
// existing tiles + the GPU-memory MiB tile + the FPS tile). The M4-D2
// "Log to file" card is DELETED from this page (item G - the Settings page
// keeps the persisted toggle; the boot-level log writer is untouched).
//
// The graph math lives in pure/graph.ts (series push, time-window trim,
// min/max scaling, downsampling - unit-tested); this file only owns the DOM
// and the thin Canvas drawing.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { consumeOverlayViewRequest } from '../router.ts';
import { api } from '../ipc.ts';
import type { TelemetrySample } from '../types.ts';
import { setLatestFps } from '../log-state.ts';
import { ghzFreq, gbValue } from '../pure/sysinfo.ts';
import { renderOverlaySettings } from './overlay-settings.ts';
import {
  pushSeries,
  trimSeriesWindow,
  sortSeriesByTime,
  autoScale,
  downsample,
  nearestSampleIndex,
  GRAPH_WINDOW_S,
} from '../pure/graph.ts';
import type { SeriesPoint } from '../pure/graph.ts';

const FPS_POLL_MS = 1000;
const DRAW_MAX_POINTS = 240;
// M4-D2 (plan-review M5): the PresentMon mention is gone - the FPS source is
// the DXGI frame-statistics/duplication adapter; unavailable -> honest '-'.
const FPS_UNAVAILABLE_NOTE = 'FPS unavailable - no frame statistics are being reported on this machine.';
const FPS_CHECKING_NOTE = 'Checking FPS…';

interface SegmentDef {
  id: string;
  label: string;
  unit: string;
  value: (s: TelemetrySample | null) => number | undefined;
}

const SEGMENTS: SegmentDef[] = [
  { id: 'clock', label: 'Core clock', unit: 'MHz', value: (s) => s?.gpuClockMhz },
  { id: 'temp', label: 'Temperature', unit: '°C', value: (s) => s?.tempC },
  { id: 'power', label: 'Power', unit: 'W', value: (s) => s?.powerW },
  // M4-I (D4): the util segment reads `gpuUtilPct ?? utilPct` - the no-Intel
  // OS GPUEngine counter is the only source there; the IGCL activity counter
  // wins on Intel when the OS counter is unpopulated.
  { id: 'util', label: 'Utilization', unit: '%', value: (s) => s?.gpuUtilPct ?? s?.utilPct },
  { id: 'fan', label: 'Fan', unit: 'RPM', value: (s) => s?.fanRpm?.[0] },
];

interface MonState {
  deviceId: number | null;
  series: Record<string, SeriesPoint[]>;
  canvases: Map<string, HTMLCanvasElement>;
  fpsTileValue: HTMLElement | null;
  fpsNote: HTMLElement | null;
  // M4-C (round-1 fix): the last hover's crosshair position (canvas CSS
  // px), persisted so a STATIONARY hover survives telemetry ticks -
  // redrawAll passes it back into drawSeries. Without it the crosshair
  // vanished on every tick (the popup stayed, the crosshair flickered out
  // until the next pointermove). Cleared on pointer-leave / collapse.
  hover: { segId: string; x: number; y: number } | null;
}

let mon: MonState | null = null;
let fpsTimer: number | null = null;

// M9: the Monitoring page's sub-view - 'monitoring' = the readout grid +
// canvas graphs, 'overlay' = the overlay settings content. Module-level
// (persists across re-renders - a navigation re-entry must not drop the
// active view, the Tuning pattern); the #/overlay alias + the Settings
// "Overlay settings" button force 'overlay' via consumeOverlayViewRequest
// at render.
let monView: 'monitoring' | 'overlay' = 'monitoring';
let viewContainer: HTMLElement | null = null;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#4cc2ff';
}

/** The same value formatting as the dashboard readout ('-' for null). */
function statValue(v: number | null | undefined, decimals = 0): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '-' : decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
}

function statTileNode(t: { label: string; value: string; unit: string; extraClass?: string }): HTMLElement {
  return el('div', { class: `stat-tile${t.extraClass ? ` ${t.extraClass}` : ''}` }, [
    el('div', { class: 'stat-value', text: t.value }),
    el('div', { class: 'stat-unit', text: t.unit }),
    el('div', { class: 'stat-label', text: t.label }),
  ]);
}

/** M4M (B)/M4N (B): the CPU group - the DASHBOARD CPU tiles verbatim (same
 *  labels + same statValue formatting): Util / Core Frequency (GHz - the
 *  shared ghzFreq helper) / Temperature / Power. */
function cpuStatTiles(sample: TelemetrySample | null): Array<{ label: string; value: string; unit: string }> {
  return [
    { label: 'Util', value: statValue(sample?.cpuUtilPct), unit: '%' },
    { label: 'Core Frequency', value: ghzFreq(sample?.cpuFreqMhz), unit: 'GHz' },
    { label: 'Temperature', value: statValue(sample?.cpuTempC), unit: '°C' },
    { label: 'Power', value: statValue(sample?.cpuPowerW, 1), unit: 'W' },
  ];
}

/** M4M (B)/M4N (B): the GPU group - the DASHBOARD GPU tile set (Util FIRST,
 *  the M4N rename of 'Utilization' -> 'Util', 'Power' already matched) +
 *  the VRAM tile (M4N: the GPU-memory MiB tile becomes 'VRAM' in GB via the
 *  shared gbValue helper - 2971324416 bytes -> '3.0') + the FPS tile (the
 *  mon-fps-tile class - pollFps owns it, last). */
function gpuStatTiles(sample: TelemetrySample | null): Array<{ label: string; value: string; unit: string; extraClass?: string }> {
  return [
    // M4-I (D4): the util tile reads `gpuUtilPct ?? utilPct` like the graph
    // segment (the no-Intel OS-counter source; IGCL wins when populated).
    { label: 'Util', value: statValue(sample?.gpuUtilPct ?? sample?.utilPct), unit: '%' },
    { label: 'Core clock', value: statValue(sample?.gpuClockMhz), unit: 'MHz' },
    { label: 'Memory clock', value: statValue(sample?.memClockMhz), unit: 'MHz' },
    { label: 'VRAM', value: gbValue(sample?.gpuMemUsedBytes), unit: 'GB' },
    { label: 'Temperature', value: statValue(sample?.tempC), unit: '°C' },
    { label: 'Power', value: statValue(sample?.powerW, 1), unit: 'W' },
    { label: 'Fan', value: statValue(sample?.fanRpm?.[0]), unit: 'RPM' },
    { label: 'FPS', value: '-', unit: 'FPS', extraClass: 'mon-fps-tile' },
  ];
}

/**
 * Thin Canvas 2D draw: grid + min/max labels + the downsampled polyline.
 * Pure data in, pixels out - no math of consequence lives here.
 * M4-C: an optional `crosshair` ({x, y} in CSS pixels, from the nearest
 * sample of a hover) draws the dashed crosshair + a dot on the sample.
 */
function drawSeries(canvas: HTMLCanvasElement, points: SeriesPoint[], crosshair: { x: number; y: number } | null = null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const scale = autoScale(points);
  if (!scale) {
    ctx.fillStyle = cssVar('--text-dim');
    ctx.font = '11px system-ui';
    ctx.fillText('Waiting for telemetry…', 8, 18);
    return;
  }

  const padL = 42;
  const padR = 8;
  const padT = 8;
  const padB = 16;
  const pw = Math.max(10, w - padL - padR);
  const ph = Math.max(10, h - padT - padB);
  const span = scale.max - scale.min;
  const y = (v: number): number => padT + (1 - (v - scale.min) / span) * ph;
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const tSpan = tMax - tMin > 0 ? tMax - tMin : GRAPH_WINDOW_S;
  const x = (t: number): number => padL + ((t - tMin) / tSpan) * pw;

  const dim = cssVar('--text-dim');
  const border = cssVar('--border');
  const accent = cssVar('--accent');

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui';
  ctx.fillStyle = dim;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (ph / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
    const gv = scale.max - (span / 4) * i;
    ctx.fillText(`${gv.toFixed(gv >= 100 ? 0 : 1)}`, 2, gy + 3);
  }
  ctx.fillText(`${tSpan.toFixed(0)}s`, padL, h - 4);

  const drawn = downsample(points, DRAW_MAX_POINTS);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  drawn.forEach((p, i) => {
    const px = x(p.t);
    const py = y(p.v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // M4-C: the hover crosshair - dashed cross lines through the nearest
  // sample + a dot on the sample itself.
  if (crosshair) {
    ctx.strokeStyle = dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(crosshair.x, padT);
    ctx.lineTo(crosshair.x, h - padB);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padL, crosshair.y);
    ctx.lineTo(w - padR, crosshair.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(crosshair.x, crosshair.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function pollFps(): Promise<void> {
  if (!mon || mon.deviceId === null) return;
  let sample: { fps: number | null; frameTimeMs: number | null; gpuBusy: number | null } | null = null;
  try {
    sample = await api.fpsPoll(mon.deviceId);
  } catch {
    sample = null;
  }
  if (!mon) return; // navigated away while polling
  // M4-D2 (§10): the log-to-file sender reads the latest FPS through the
  // shared module - the log line carries the best-effort fps even when the
  // Monitoring page is not the current page (the BOOT-level subscription
  // does the logging).
  setLatestFps(sample?.fps ?? null);
  if (mon.fpsTileValue && mon.fpsNote) {
    if (sample && sample.fps !== null && Number.isFinite(sample.fps)) {
      mon.fpsTileValue.textContent = String(Math.round(sample.fps));
      mon.fpsNote.textContent = sample.frameTimeMs !== null ? `Frame time ${sample.frameTimeMs.toFixed(1)} ms` : '';
    } else {
      mon.fpsTileValue.textContent = '-';
      mon.fpsNote.textContent = FPS_UNAVAILABLE_NOTE;
    }
  }
}

export const monitoringPage: Page = {
  id: 'monitoring',

  render(container: HTMLElement, ctx: PageContext) {
    // Navigation re-entry: stop the previous poll loop, reset the state.
    if (fpsTimer !== null) {
      window.clearInterval(fpsTimer);
      fpsTimer = null;
    }
    const s = ctx.store.get();
    mon = {
      deviceId: s.deviceId,
      series: Object.fromEntries(SEGMENTS.map((seg) => [seg.id, [] as SeriesPoint[]])),
      canvases: new Map(),
      fpsTileValue: null,
      fpsNote: null,
      hover: null,
    };

    // M9: the old #/overlay hash + the Settings-button path arrive with the
    // overlay view requested (the consumeFanViewRequest twin - the Tuning
    // pattern); the view persists per render (module state, default
    // 'monitoring').
    if (consumeOverlayViewRequest()) monView = 'overlay';

    clear(container);
    const viewToggle = el('div', { class: 'mon-view-toggle-row' }, [
      el('div', { class: 'oc-mode-toggle mon-view-toggle', role: 'group', 'aria-label': 'Monitoring view' }, [
        el('button', {
          class: `oc-mode-btn mon-view-btn${monView === 'monitoring' ? ' active' : ''}`,
          dataset: { view: 'monitoring' },
          text: 'Monitoring',
          onClick: () => setMonView('monitoring'),
        }),
        el('button', {
          class: `oc-mode-btn mon-view-btn${monView === 'overlay' ? ' active' : ''}`,
          dataset: { view: 'overlay' },
          text: 'Overlay',
          onClick: () => setMonView('overlay'),
        }),
      ]),
    ]);
    viewContainer = el('div', { class: 'mon-view' });
    container.append(
      el('h1', { class: 'page-title', text: 'Monitoring' }),
      el('p', {
        class: 'page-subtitle',
        text: monView === 'overlay'
          ? 'The in-game style HUD - its settings live in the Overlay view below (the readout grid keeps running behind it).'
          : 'Live values and 60-second rolling graphs from the GPU.',
      }),
      viewToggle,
      viewContainer,
    );
    // M9: the view switch re-renders ONLY the sub-view container - the
    // telemetry series (module-level mon.series) survive the round trip,
    // and every monitoring-view rebuild re-registers the canvases + the
    // FPS tile + the note (the S2 contract in renderMonitoringView).
    const renderMonView = (): void => {
      if (!viewContainer) return;
      if (monView === 'overlay') {
        renderOverlaySettings(viewContainer, ctx);
        return;
      }
      renderMonitoringView(viewContainer, ctx);
    };
    const setMonView = (v: 'monitoring' | 'overlay'): void => {
      if (monView === v) return;
      monView = v;
      renderMonView();
      viewToggle.querySelectorAll<HTMLButtonElement>('.mon-view-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === monView);
      });
    };
    renderMonView();

    fpsTimer = window.setInterval(() => void pollFps(), FPS_POLL_MS);
    void pollFps();
    redrawAll();
  },

  // M2b review F4: the router calls this on navigation away - the 1 s FPS
  // poll must not keep firing (and touching stale DOM) on other pages.
  leave() {
    if (fpsTimer !== null) {
      window.clearInterval(fpsTimer);
      fpsTimer = null;
    }
    mon = null;
  },

  onUpdate(container: HTMLElement, ctx: PageContext) {
    if (!mon) return;
    const sample = ctx.store.get().latestSample;
    const now = sample?.t ?? Date.now();
    for (const seg of SEGMENTS) {
      const value = seg.value(sample);
      if (value !== undefined) {
        // M4-D2 fix ("the lines overlap"): the REAL driver's
        // telemetry t occasionally ticks BACKWARD (live-verified: 8 folds
        // in 40 s under load) - an unsorted push would fold the polyline
        // over itself. sortSeriesByTime keeps the drawn line on the true
        // chronological timeline - never a fold, never overlapping.
        mon.series[seg.id] = trimSeriesWindow(
          sortSeriesByTime(pushSeries(mon.series[seg.id], sample?.t ?? now, value)),
          now,
          GRAPH_WINDOW_S,
        );
      }
    }
    // M4M (B): refresh the readout groups IN PLACE - rebuild each grid per
    // tick (the dashboard pattern). The FPS tile is owned by pollFps - the
    // rebuild KEEPS the existing tile element (moved to the end of the GPU
    // grid) so the poll's live value is never stomped. M9: the grids only
    // exist while the MONITORING view is active (the overlay view leaves
    // them absent - the null-safe lookup just returns).
    const refreshGroup = (id: string, tiles: Array<{ label: string; value: string; unit: string; extraClass?: string }>): void => {
      const grid = container.querySelector<HTMLElement>(`#${id}`);
      if (!grid) return;
      const fpsTile = grid.querySelector<HTMLElement>('.mon-fps-tile');
      clear(grid);
      grid.append(...tiles.filter((t) => t.extraClass !== 'mon-fps-tile').map(statTileNode));
      if (fpsTile) grid.append(fpsTile);
    };
    if (sample) {
      refreshGroup('mon-readout-cpu', cpuStatTiles(sample));
      refreshGroup('mon-readout-gpu', gpuStatTiles(sample));
    }
    redrawAll();
  },
};

/** M9: the monitoring sub-view build - the readout grid + the canvas
 *  segments (the old render() body, extracted so the view switch can
 *  rebuild it). THE RE-REGISTRATION CONTRACT (plan-review S2): every
 *  (re)build re-registers mon.canvases, mon.fpsTileValue and mon.fpsNote,
 *  so pollFps + redrawAll always write into the LIVE view and never into
 *  the detached nodes a clear(viewContainer) orphans (a re-shown view
 *  would otherwise show a frozen FPS tile + empty graphs). */
function renderMonitoringView(container: HTMLElement, ctx: PageContext): void {
  const m = mon;
  if (!m) return;
  clear(container);
  const s = ctx.store.get();
  m.canvases = new Map();
  const fpsNote = el('p', { class: 'card-note mon-fps-note', text: FPS_CHECKING_NOTE });
  m.fpsNote = fpsNote;

  // M4M (B): the readout card renders TWO labeled groups (CPU above GPU -
  // the dashboard pattern), each with its own grid (mon-readout-cpu /
  // mon-readout-gpu; both keep the compact .mon-readout styling). The
  // FPS tile starts '-' - pollFps owns it from the first poll.
  const readout = el('section', { class: 'card' }, [
    el('h2', { class: 'card-title', text: 'Live readout' }),
    el('div', { class: 'readout-group' }, [
      el('div', { class: 'readout-group-label', text: 'CPU' }),
      el('div', { class: 'readout-grid mon-readout', id: 'mon-readout-cpu' }, cpuStatTiles(s.latestSample).map(statTileNode)),
    ]),
    el('div', { class: 'readout-group' }, [
      el('div', { class: 'readout-group-label', text: 'GPU' }),
      el('div', { class: 'readout-grid mon-readout', id: 'mon-readout-gpu' }, gpuStatTiles(s.latestSample).map(statTileNode)),
    ]),
    fpsNote,
  ]);
  m.fpsTileValue = readout.querySelector('.mon-fps-tile .stat-value') as HTMLElement;

  const graphs = el('section', { class: 'seg-stack' }, SEGMENTS.map((seg, idx) => {
    const canvas = el('canvas', { class: 'seg-canvas' });
    m.canvases.set(seg.id, canvas);
    const popup = el('div', { class: 'seg-popup', hidden: true });
    const body = el('div', { class: 'seg-body' }, [canvas, popup]);
    const head = el('button', {
      class: 'seg-head',
      onClick: () => {
        const collapsed = body.hidden;
        body.hidden = !collapsed;
        head.querySelector('.seg-chevron')!.textContent = collapsed ? '▾' : '▸';
        // M4-C: collapsing the segment hides any stale hover popup and
        // clears the persisted crosshair.
        if (body.hidden) {
          popup.hidden = true;
          if (mon) mon.hover = null;
        }
        drawSeries(canvas, mon?.series[seg.id] ?? []);
      },
    }, [
      el('span', { class: 'seg-chevron', text: idx === 0 ? '▾' : '▸' }),
      el('span', { class: 'seg-label', text: seg.label }),
      el('span', { class: 'seg-unit', text: seg.unit }),
    ]);
    // Collapsed by default except the first segment.
    if (idx !== 0) body.hidden = true;

    // M4-C: hover crosshair + nearest-sample popup - only while the
    // segment is EXPANDED (the collapsed body is hidden, and the handler
    // re-checks so a collapse mid-hover can never leave a popup behind).
    const hideHover = () => {
      popup.hidden = true;
      if (mon) mon.hover = null;
      drawSeries(canvas, mon?.series[seg.id] ?? []);
    };
    canvas.addEventListener('pointermove', (ev) => {
      if (body.hidden) return;
      const points = mon?.series[seg.id] ?? [];
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0 || points.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const padL = 42;
      const padR = 8;
      const padT = 8;
      const padB = 16;
      const pw = Math.max(10, w - padL - padR);
      const xNorm = (ev.clientX - rect.left - padL) / pw;
      const idx = nearestSampleIndex(points, xNorm);
      if (idx < 0) return;
      const p = points[idx];
      const scale = autoScale(points);
      if (!scale) return;
      const ph = Math.max(10, h - padT - padB);
      const span = scale.max - scale.min;
      const x = padL + xNorm * pw;
      const y = padT + (1 - (p.v - scale.min) / span) * ph;
      // Relative time against the newest sample in the drawn window.
      const nowT = points[points.length - 1].t;
      popup.textContent = `${Math.round(p.v)} ${seg.unit} · ${Math.round(nowT - p.t)} s ago`;
      // The canvas starts at the body's padding box + 10px/8px padding.
      // M4-C (round-2 fix): the popup must stay FULLY inside the card -
      // the old unclamped `left: 10 + x` (x reaches w - 8 at the canvas's
      // right edge) centered the ~120px box up to ~60px past the card's
      // right edge, and .seg-card{overflow:hidden} clipped the "· N s
      // ago" tail - and the rightmost ~5 s of the graph is where the
      // NEWEST sample (the common hover) sits. Top-edge samples
      // (v = max -> y = padT = 8) parked the box ~12px above the canvas,
      // over the segment header. Mirror the fan readout's round-1 fix:
      // measure the segment body + box, clamp horizontally in px so the
      // box never leaves the card, and flip BELOW the sample (the
      // .seg-popup-below class) when there is no room above. The
      // %-positioned default stays as the fallback when the body cannot
      // be measured.
      popup.hidden = false;
      const bodyEl = popup.parentElement;
      const br = bodyEl ? bodyEl.getBoundingClientRect() : null;
      if (br && br.width > 0 && br.height > 0) {
        const box = popup.getBoundingClientRect();
        const px = 10 + x;
        const py = 8 + y;
        const flipBelow = py - 6 - box.height < 0 && py + 10 + box.height <= br.height;
        popup.classList.toggle('seg-popup-below', flipBelow);
        popup.style.left = `${Math.min(Math.max(box.width / 2, px), br.width - box.width / 2)}px`;
        popup.style.top = `${py}px`;
      } else {
        popup.classList.remove('seg-popup-below');
        popup.style.left = `${10 + x}px`;
        popup.style.top = `${8 + y}px`;
      }
      // M4-C (round-1 fix): persist the hover so redrawAll can re-draw
      // the crosshair on telemetry ticks (a stationary hover used to lose
      // it every second while the popup stayed).
      if (mon) mon.hover = { segId: seg.id, x, y };
      drawSeries(canvas, points, { x, y });
    });
    canvas.addEventListener('pointerleave', hideHover);
    return el('div', { class: 'card seg-card' }, [head, body]);
  }));

  container.append(readout, graphs);
}

function redrawAll(): void {
  if (!mon) return;
  for (const [id, canvas] of mon.canvases) {
    // M4-C (round-1 fix): pass the persisted hover crosshair through every
    // redraw - without it a stationary hover lost the crosshair on each
    // telemetry tick (the popup stayed but the crosshair vanished until the
    // next pointermove).
    const crosshair = mon.hover && mon.hover.segId === id ? { x: mon.hover.x, y: mon.hover.y } : null;
    drawSeries(canvas, mon.series[id] ?? [], crosshair);
  }
}

/**
 * 1.0.1 (N9): redraw the canvases NOW - a theme switch recolors the graphs
 * immediately (drawSeries reads the CSS vars at draw time; without this
 * hook the graphs would keep the old palette until the next telemetry
 * tick). No-op when the Monitoring page is not mounted.
 */
export function redrawMonitoringGraphs(): void {
  redrawAll();
}
