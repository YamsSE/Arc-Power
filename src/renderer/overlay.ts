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
//
// M6: the SAME push carries the persisted overlayColor + overlayStats. The
// color applies via CSSOM (a --overlay-color CSS var on <html> - CSP-safe:
// style-src 'self' blocks inline style ATTRIBUTES, not stylesheet/CSSOM
// writes; the frametime canvas strokeStyle takes the SAME hex - never the
// old hardcoded white) and the stats drive which fields/lines render (a
// stat off -> its field vanishes; a line fully off -> the div writes '' -
// the fixed divs are never removed). The frametime stat is NOT a line - it
// toggles the canvas strip's visibility.
//
// M6-amd2 (the user's amendment - the "below the FPS" part retracted, the
// graph stays at the bottom): a frametime VALUE line sits directly BELOW
// the canvas (#overlay-frametime-value) showing the latest derived frame
// time with MAXIMUM 2 decimals ('16.67 ms' / '16.7 ms' - never padded;
// honest '-' when no data). The frametime stat controls BOTH the strip
// and the number - a stat off hides them together.

import { api } from './ipc.ts';
import { overlayLines, deriveFrameTimeMs, formatFrametime, clampOverlayScale, isValidOverlayColor } from './pure/overlay.ts';
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
// M6: the pushed color + stats (undefined until the first push -> the
// stock white + the full stat set - the overlayLines defaults).
let color: string = '#ffffff';
let stats: unknown = undefined;
// M6-amd2: the latest derived frame time (the value line below the strip;
// null -> the honest '-').
let latestFrameTime: number | null = null;

const fpsEl = document.getElementById('overlay-fps') as HTMLElement;
const cpuEl = document.getElementById('overlay-cpu') as HTMLElement;
const gpuEl = document.getElementById('overlay-gpu') as HTMLElement;
const canvas = document.getElementById('overlay-frametime') as HTMLCanvasElement;
const valueEl = document.getElementById('overlay-frametime-value') as HTMLElement;

// M3: registered SYNCHRONOUSLY at script top - BEFORE any await - so the
// initial 'overlay:settings' push (main sends it right after
// did-finish-load) is never missed by the boot sequence.
api.onOverlaySettings((settings) => {
  const s = settings ?? {};
  scale = clampOverlayScale(s.scale);
  // The CSSOM font-size scaling (CSP-safe): one change scales every rem
  // size in the HUD - the same persisted scale the window was resized with.
  document.documentElement.style.fontSize = `${BASE_FONT_PX * scale}px`;
  // M6: the text color - ONE CSS var on <html>, read by overlay.css for
  // the line color + by draw() for the canvas stroke (a non-white color
  // must recolor BOTH - the old hardcoded '#ffffff' stroke would betray a
  // color change). Garbage degrades to the stock white.
  color = isValidOverlayColor(s.color) ? s.color : '#ffffff';
  document.documentElement.style.setProperty('--overlay-color', color);
  // M6: the enabled stats - an absent value means the FULL set (the stock
  // overlay; overlayLines normalizes).
  stats = s.stats;
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
  const lines = overlayLines(latestSample, latestFps, stats);
  fpsEl.textContent = lines.fpsLine;
  cpuEl.textContent = lines.cpuLine;
  gpuEl.textContent = lines.gpuLine;
  // M6/M6-amd2: the frametime stat is NOT a line - it toggles the canvas
  // strip's AND the value line's visibility together (a fully-off line
  // writes '' into its KEPT div, but the strip + the number are HIDDEN -
  // an empty 31rem strip / a stale number would still occupy space).
  canvas.style.display = lines.frametimeEnabled ? '' : 'none';
  valueEl.style.display = lines.frametimeEnabled ? '' : 'none';
  // The value line: the latest derived frame time (max 2 decimals; the
  // honest '-' when the last poll had nothing to derive from).
  valueEl.textContent = lines.frametimeEnabled ? formatFrametime(latestFrameTime) : '';
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
  // M6: the stroke takes the SAME hex as the text lines (the pushed
  // overlayColor - never the old hardcoded '#ffffff').
  ctx.strokeStyle = color;
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
      // 1000/fps (TWO decimals - M6-amd2: the value line shows max 2
      // decimals; the fps-0 guard keeps Infinity out). The series is
      // trimmed to the ~120-sample window. The series t is in SECONDS
      // (Date.now() / 1000) - the SAME time unit the pure/graph helpers
      // use (their windowS is seconds too; a millisecond t with a 120 s
      // window would trim every point but the newest).
      const ft = deriveFrameTimeMs(fps, sample.frameTimeMs);
      // M6-amd2: the value line tracks the SAME latest derived frame time
      // (null when the poll had nothing -> the honest '-').
      latestFrameTime = ft;
      if (ft !== null) {
        const now = Date.now() / 1000;
        series = trimSeriesWindow(pushSeries(series, now, ft, FRAMETIME_DRAW_POINTS), now, FRAMETIME_WINDOW_S);
      }
      render();
    })();
  }, 1000);
}

void bootFpsLoop();
