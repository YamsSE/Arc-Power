// Arc Power — Monitoring page (M2b-B): live readout grid fed by the
// telemetry IPC push + one rolling Canvas graph per segment (core clock,
// temperature, power, utilization, fan) with a 60 s window. Each segment is
// COLLAPSIBLE (header row + chevron; collapsed by default except the first).
// FPS comes from the fps-poll IPC channel; when PresentMon is unavailable
// the page shows "FPS unavailable" gracefully — never an error.
//
// The graph math lives in pure/graph.ts (series push, time-window trim,
// min/max scaling, downsampling — unit-tested); this file only owns the DOM
// and the thin Canvas drawing.

import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import type { TelemetrySample } from '../types.ts';
import {
  pushSeries,
  trimSeriesWindow,
  autoScale,
  downsample,
  GRAPH_WINDOW_S,
} from '../pure/graph.ts';
import type { SeriesPoint } from '../pure/graph.ts';

const FPS_POLL_MS = 1000;
const DRAW_MAX_POINTS = 240;
const FPS_UNAVAILABLE_NOTE = 'FPS unavailable — PresentMon is not reporting frames on this machine.';
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
  { id: 'util', label: 'Utilization', unit: '%', value: (s) => s?.utilPct },
  { id: 'fan', label: 'Fan', unit: 'RPM', value: (s) => s?.fanRpm?.[0] },
];

interface MonState {
  deviceId: number | null;
  series: Record<string, SeriesPoint[]>;
  readoutGrid: HTMLElement | null;
  canvases: Map<string, HTMLCanvasElement>;
  fpsTileValue: HTMLElement | null;
  fpsNote: HTMLElement | null;
}

let mon: MonState | null = null;
let fpsTimer: number | null = null;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#4cc2ff';
}

function statTile(label: string, value: string, unit: string, extraClass = ''): HTMLElement {
  return el('div', { class: `stat-tile${extraClass ? ` ${extraClass}` : ''}` }, [
    el('div', { class: 'stat-value', text: value }),
    el('div', { class: 'stat-unit', text: unit }),
    el('div', { class: 'stat-label', text: label }),
  ]);
}

function readoutTiles(sample: TelemetrySample | null): HTMLElement[] {
  const num = (v: number | undefined, decimals = 0): string => (v === undefined || !Number.isFinite(v) ? '—' : decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)));
  const fpsTile = statTile('FPS', '—', 'FPS', 'mon-fps-tile');
  return [
    statTile('Core clock', num(sample?.gpuClockMhz), 'MHz'),
    statTile('Memory clock', num(sample?.memClockMhz), 'MHz'),
    statTile('Temperature', num(sample?.tempC), '°C'),
    statTile('Power', num(sample?.powerW, 1), 'W'),
    statTile('Utilization', num(sample?.utilPct), '%'),
    statTile('Fan', num(sample?.fanRpm?.[0]), 'RPM'),
    fpsTile,
  ];
}

/**
 * Thin Canvas 2D draw: grid + min/max labels + the downsampled polyline.
 * Pure data in, pixels out — no math of consequence lives here.
 */
function drawSeries(canvas: HTMLCanvasElement, points: SeriesPoint[]): void {
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
  if (mon.fpsTileValue && mon.fpsNote) {
    if (sample && sample.fps !== null && Number.isFinite(sample.fps)) {
      mon.fpsTileValue.textContent = String(Math.round(sample.fps));
      mon.fpsNote.textContent = sample.frameTimeMs !== null ? `Frame time ${sample.frameTimeMs.toFixed(1)} ms` : '';
    } else {
      mon.fpsTileValue.textContent = '—';
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
      readoutGrid: null,
      canvases: new Map(),
      fpsTileValue: null,
      fpsNote: null,
    };

    clear(container);
    const fpsNote = el('p', { class: 'card-note mon-fps-note', text: FPS_CHECKING_NOTE });
    mon.fpsNote = fpsNote;

    const readout = el('section', { class: 'card' }, [
      el('h2', { class: 'card-title', text: 'Live readout' }),
      el('div', { class: 'readout-grid mon-readout' }, readoutTiles(s.latestSample)),
      fpsNote,
    ]);
    mon.readoutGrid = readout.querySelector('.mon-readout');
    mon.fpsTileValue = readout.querySelector('.mon-fps-tile .stat-value') as HTMLElement;

    const graphs = el('section', { class: 'seg-stack' }, SEGMENTS.map((seg, idx) => {
      const canvas = el('canvas', { class: 'seg-canvas' });
      mon?.canvases.set(seg.id, canvas);
      const body = el('div', { class: 'seg-body' }, [canvas]);
      const head = el('button', {
        class: 'seg-head',
        onClick: () => {
          const collapsed = body.hidden;
          body.hidden = !collapsed;
          head.querySelector('.seg-chevron')!.textContent = collapsed ? '▾' : '▸';
          drawSeries(canvas, mon?.series[seg.id] ?? []);
        },
      }, [
        el('span', { class: 'seg-chevron', text: idx === 0 ? '▾' : '▸' }),
        el('span', { class: 'seg-label', text: seg.label }),
        el('span', { class: 'seg-unit', text: seg.unit }),
      ]);
      // Collapsed by default except the first segment.
      if (idx !== 0) body.hidden = true;
      return el('div', { class: 'card seg-card' }, [head, body]);
    }));

    container.append(
      el('h1', { class: 'page-title', text: 'Monitoring' }),
      el('p', { class: 'page-subtitle', text: 'Live values and 60-second rolling graphs from the GPU.' }),
      readout,
      graphs,
    );

    fpsTimer = window.setInterval(() => void pollFps(), FPS_POLL_MS);
    void pollFps();
    redrawAll();
  },

  // M2b review F4: the router calls this on navigation away — the 1 s FPS
  // poll must not keep firing (and touching stale DOM) on other pages.
  leave() {
    if (fpsTimer !== null) {
      window.clearInterval(fpsTimer);
      fpsTimer = null;
    }
    mon = null;
  },

  onUpdate(_container: HTMLElement, ctx: PageContext) {
    if (!mon) return;
    const sample = ctx.store.get().latestSample;
    const now = sample?.t ?? Date.now();
    for (const seg of SEGMENTS) {
      const value = seg.value(sample);
      if (value !== undefined) {
        mon.series[seg.id] = trimSeriesWindow(pushSeries(mon.series[seg.id], sample?.t ?? now, value), now, GRAPH_WINDOW_S);
      }
    }
    // Refresh the readout grid tiles in place (values only). The FPS tile is
    // owned by pollFps — telemetry ticks must never stomp it.
    const grid = mon.readoutGrid;
    if (grid && sample) {
      const tiles = readoutTiles(sample);
      const values = grid.querySelectorAll('.stat-value');
      tiles.forEach((tile, i) => {
        if (!tile.classList.contains('mon-fps-tile') && values[i]) {
          (values[i] as HTMLElement).textContent = (tile.querySelector('.stat-value') as HTMLElement).textContent;
        }
      });
    }
    redrawAll();
  },
};

function redrawAll(): void {
  if (!mon) return;
  for (const [id, canvas] of mon.canvases) {
    drawSeries(canvas, mon.series[id] ?? []);
  }
}
