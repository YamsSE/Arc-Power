// Arc Power - M5 the software overlay renderer (the Overlay window).
//
// Renders the RTSS-style HUD: three BOLD monospace lines (FPS / CPU / GPU)
// from the forwarded telemetry stream + the 1 s fps-poll, plus the frametime
// polyline on a transparent canvas (ONLY the 1.5px line - no grid, no
// background). The window itself is transparent/frameless/unfocusable and
// ignores mouse input - the text floats directly over the screen/game.
//
// The scale's single source of truth (M7): the 'overlay:settings' push
// carries the SAME persisted overlayScale the main-side geometry used for
// the window resize (the push + the resize are applied together in main) -
// this renderer re-renders against the pushed value, never its own copy.

import { api } from './ipc.ts';
import { overlayLines, deriveFrameTimeMs, clampOverlayScale } from './pure/overlay.ts';
import { pushSeries, trimSeriesWindow, autoScale, downsample } from './pure/graph.ts';
import type { SeriesPoint } from './pure/graph.ts';
import type { FpsSample, TelemetrySample } from './types.ts';

/** The base font size at scale 1.0 (CSS px; overlay.css matches). */
const BASE_FONT_PX = 14;
/** The frametime series window: ~120 samples at the 1 s poll cadence (the
 *  pure/graph window seconds). The draw cap is the same count (120 - the
 *  downsample max; never more points than the window holds). */
const FRAMETIME_WINDOW_S = 120;
const FRAMETIME_DRAW_POINTS = 120;

let scale = 1;
let latestSample: TelemetrySample | null = null;
let latestFps: number | null = null;
let series: SeriesPoint[] = [];

const fpsEl = document.getElementById('overlay-fps') as HTMLElement;
const cpuEl = document.getElementById('overlay-cpu') as HTMLElement;
const gpuEl = document.getElementById('overlay-gpu') as HTMLElement;
const canvas = document.getElementById('overlay-frametime') as HTMLCanvasElement;

// M3: registered SYNCHRONOUSLY at script top - BEFORE any await - so the
// initial 'overlay:settings' push (main sends it right after
// did-finish-load) is never missed by the boot sequence.
api.onOverlaySettings((settings) => {
  const s = settings ?? {};
  scale = clampOverlayScale(s.scale);
  // The CSSOM font-size scaling (CSP-safe): one change scales every rem
  // size in the HUD - the same persisted scale the window was resized with.
  document.documentElement.style.fontSize = `${BASE_FONT_PX * scale}px`;
  sizeCanvas();
  render();
});

function sizeCanvas(): void {
  // Match the canvas bitmap to its scaled CSS size (the polyline spans the
  // full scaled width).
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function render(): void {
  const lines = overlayLines(latestSample, latestFps);
  fpsEl.textContent = lines.fpsLine;
  cpuEl.textContent = lines.cpuLine;
  gpuEl.textContent = lines.gpuLine;
  draw();
}

/** The frametime polyline - ONLY the 1.5px line (no grid, no background
 *  rect). The y axis auto-scales to the series (the pure/graph math). */
function draw(): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (series.length < 2) return;
  const range = autoScale(series);
  if (!range) return;
  const span = range.max - range.min;
  if (!(span > 0)) return;
  const drawn = downsample(series, FRAMETIME_DRAW_POINTS);
  const x = (i: number): number => (i / (drawn.length - 1)) * canvas.width;
  const y = (v: number): number => canvas.height - ((v - range.min) / span) * canvas.height;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  drawn.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(i), y(p.v));
    else ctx.lineTo(x(i), y(p.v));
  });
  ctx.stroke();
}

// The telemetry push (forwarded to BOTH windows by main's emit) feeds the
// stat lines. The overlay relies on the MAIN window's telemetry session -
// it keeps working while the main window is closed-to-tray (hidden, alive).
api.onTelemetrySample((sample) => {
  latestSample = sample;
  render();
});

// M3b: the fps poll runs on its OWN 1 s loop (the overlay keeps working
// when the main window is closed-to-tray - no dependency on the Monitoring
// page). The deviceId resolves via device-get at boot; the poll is SKIPPED
// when it is null (the no-Intel / fresh-store case - api.fpsPoll rejects on
// null via assertValidDeviceId) and the fps line honestly stays '-'.
async function bootFpsLoop(): Promise<void> {
  let deviceId: number | null = null;
  try {
    const d = await api.deviceGet();
    deviceId = typeof d?.deviceId === 'number' && d.deviceId >= 0 ? d.deviceId : null;
  } catch {
    deviceId = null;
  }
  if (deviceId === null) return;
  window.setInterval(() => {
    void (async () => {
      let sample: FpsSample | null = null;
      try {
        sample = await api.fpsPoll(deviceId);
      } catch {
        sample = null;
      }
      if (!sample) return;
      const fps = typeof sample.fps === 'number' ? sample.fps : null;
      latestFps = fps;
      // S1/M2: the frametime series - the real DXGI adapter returns
      // frameTimeMs: null on every path, so deriveFrameTimeMs derives
      // 1000/fps (ONE decimal; the fps-0 guard keeps Infinity out). The
      // series is trimmed to the ~120-sample window. The series t is in
      // SECONDS (Date.now() / 1000) - the SAME time unit the pure/graph
      // helpers use (their windowS is seconds too; a millisecond t with a
      // 120 s window would trim every point but the newest).
      const ft = deriveFrameTimeMs(fps, sample.frameTimeMs);
      if (ft !== null) {
        const now = Date.now() / 1000;
        series = trimSeriesWindow(pushSeries(series, now, ft, FRAMETIME_DRAW_POINTS), now, FRAMETIME_WINDOW_S);
      }
      render();
    })();
  }, 1000);
}

void bootFpsLoop();
