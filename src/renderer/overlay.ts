// Arc Power - M5 the software overlay renderer (the Overlay window).
//
// Renders the RTSS-style HUD: SIX BOLD monospace lines (FPS / CPU / RAM /
// GPU / VRAM / API - the M12 Memory + VRAM rows joined below the CPU / GPU
// rows; M13: the API row joined between the VRAM row and the frametime
// strip) from the forwarded telemetry stream + the 1 s fps-poll, plus the
// frametime polyline on a transparent canvas (ONLY the 1.5px line - no
// grid, no background). The window itself is transparent/frameless/
// unfocusable and ignores mouse input - the text floats directly over the
// screen/game. M16 (amended 2026-08-11): the GPU voltage renders as a
// FIELD INSIDE the GPU row (between the temp and the power fields) - the
// standalone Voltage row is gone and the line count is back to SIX.
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
// M6-amd2 (the amendment - the "below the FPS" part retracted, the
// graph stays at the bottom): a frametime VALUE line sits directly BELOW
// the canvas (#overlay-frametime-value) showing the latest derived frame
// time with MAXIMUM 2 decimals ('16.67ms' / '16.7ms' - never padded;
// M18: the unit is GLUED to the number like every other value; honest
// '-' when no data). The frametime stat controls BOTH the strip
// and the number - a stat off hides them together.

import { api } from './ipc.ts';
import { overlayLines, deriveFrameTimeMs, formatFrametime, clampOverlayScale, isValidOverlayColor, clampOverlayBgOpacity, clampOverlayPollMs, OVERLAY_BG_COLOR_DEFAULT } from './pure/overlay.ts';
// M17b (2c): the chip-name cut-down rules (pure; the boot names fetch
// derives the row labels from the sysinfo fixture/real names).
import { chipLabelGpu, chipLabelCpu } from './pure/chip-label.ts';
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
// M7a: the latest percentile stats from the fps poll (null until the
// sampler reports them - the honest '-' fields on the FPS row).
let latestLow1Pct: number | null = null;
let latestP99: number | null = null;
// M12: the window AVG + the 0.1% Low ride the same poll (null when the
// sampler has not reached their frame floors - the honest '-' fields).
let latestAvgFps: number | null = null;
let latestLow01Pct: number | null = null;
// M10a: the latest foreground-window Graphics-API id from the same poll
// (null when nothing is detected - the API row stays empty; the sample's
// null-returning polls keep the last known value, like the fps itself).
let latestApi: string | null = null;
let series: SeriesPoint[] = [];
// M6: the pushed color + stats (undefined until the first push -> the
// stock white + the full stat set - the overlayLines defaults).
let color: string = '#ffffff';
let stats: unknown = undefined;
// M17b (2c): the chip-name row labels - the pushed overlayChipNames flag +
// the boot names fetch (api.listDevices() + api.sysinfo() ONCE - the
// existing bootFpsLoop deviceGet is NOT a names fetch). The labels derive
// from the SY SINFO primary video-controller name + cpu.name (the plain
// 'Intel(R) Arc(TM) A770 Graphics' lives there - NOT listDevices, whose
// mock IGCL name is the fixture-decorated 'Mock Arc A770 Graphics
// (fixture)'; listDevices is the fallback only when sysinfo has no
// controllers). null until fetched -> the stock prefixes.
let chipNamesEnabled = false;
let cpuChipLabel: string | null = null;
let gpuChipLabel: string | null = null;
// M6-amd2: the latest derived frame time (the value line below the strip;
// null -> the honest '-').
let latestFrameTime: number | null = null;
// M17e: the telemetry push counter (the fast-rate pin's mocked-push-cadence
// surface - the ui-verify counts the pushed samples over a window).
let telemetryTicks = 0;

const fpsEl = document.getElementById('overlay-fps') as HTMLElement;
const cpuEl = document.getElementById('overlay-cpu') as HTMLElement;
// M12: the Memory + VRAM rows (the fixed-div pattern - the renderer only
// empties them, never removes).
const memoryEl = document.getElementById('overlay-memory') as HTMLElement;
const gpuEl = document.getElementById('overlay-gpu') as HTMLElement;
const vramEl = document.getElementById('overlay-vram') as HTMLElement;
// M13: the standalone Graphics-API row (the same fixed-div pattern - the
// api field LEFT the FPS row and renders here, between the VRAM row and
// the frametime strip).
const apiEl = document.getElementById('overlay-api') as HTMLElement;
const canvas = document.getElementById('overlay-frametime') as HTMLCanvasElement;
const valueEl = document.getElementById('overlay-frametime-value') as HTMLElement;
// M18/M19b: the header divider - ONE absolutely-positioned 1px line behind
// the SIX labeled rows (the root is its containing block; the divider's
// top/bottom get set from the row offsets per render, the left comes from
// the CSS calc carrying the --overlay-label-w var).
const rootEl = document.getElementById('overlay-root') as HTMLElement;
const dividerEl = document.getElementById('overlay-divider');

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
  // M7b (fix 4): the background box - the two CSS vars via CSSOM (the
  // same CSP-safe pattern) + the .visible class from overlayBgEnabled.
  // The backdrop exists in the fixed overlay.html markup; a bg change
  // re-renders on THIS push (main's applyOverlaySettings forwards the
  // three fields - without them the defaults would always push and the
  // box would never appear).
  document.documentElement.style.setProperty(
    '--overlay-bg-color',
    isValidOverlayColor(s.overlayBgColor) ? s.overlayBgColor : OVERLAY_BG_COLOR_DEFAULT,
  );
  document.documentElement.style.setProperty(
    '--overlay-bg-opacity',
    String(clampOverlayBgOpacity(s.overlayBgOpacity)),
  );
  const backdrop = document.getElementById('overlay-backdrop');
  if (backdrop) backdrop.classList.toggle('visible', s.overlayBgEnabled === true);
  // M6: the enabled stats - an absent value means the DEFAULT set (M17g:
  // the user's 11 ON / the others OFF - the M6 full-set default FLIPS;
  // overlayLines normalizes).
  stats = s.stats;
  // M17b (2c): the chip-name row labels flag - on -> the boot-derived
  // labels replace the stock 'CPU '/'GPU ' prefixes (null labels degrade
  // to the stock prefixes inside overlayLines).
  chipNamesEnabled = s.overlayChipNames === true;
  // M17e: the pushed polling-rate - the renderer carries the clamped value
  // on the documentElement dataset (the ui-verify payload pin's surface;
  // the cadence itself is main-side).
  const pollMs = clampOverlayPollMs(s.overlayPollMs);
  document.documentElement.dataset.overlayPollMs = String(pollMs);
  // M17f: the FPS-poll cadence follows the SAME slider - the bootFpsLoop
  // re-arms its interval when the pushed value changes (the FPS line then
  // updates at the user's chosen rate, not the stock 1000 ms).
  applyFpsPollMs(pollMs);
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
  // M7a: the latest percentile stats ride the same fps poll into the FPS
  // row (null -> the honest '-' fields). M10a/M13: the latest Graphics-API
  // id rides along into the STANDALONE API row (null -> the row stays
  // empty - never '-', never a raw id). M12/M14: the AVG / 0.1% Low + the
  // RAM used-bytes ride along too (the memoryUsedBytes comes from the
  // telemetry sample's composed field).
  // M17b (2c): the chip-name row labels ride into overlayLines ONLY when
  // the pushed overlayChipNames flag is on (absent/empty labels keep the
  // stock 'CPU '/'GPU ' prefixes - the labels never invent a row).
  const lines = overlayLines(
    latestSample, latestFps, stats, latestLow1Pct, latestP99, latestApi,
    latestAvgFps, latestLow01Pct, latestSample?.memoryUsedBytes ?? null,
    chipNamesEnabled ? { chipLabels: { cpu: cpuChipLabel, gpu: gpuChipLabel } } : undefined,
  );
  fpsEl.textContent = lines.fpsLine;
  cpuEl.textContent = lines.cpuLine;
  memoryEl.textContent = lines.memoryLine;
  gpuEl.textContent = lines.gpuLine;
  vramEl.textContent = lines.vramLine;
  apiEl.textContent = lines.apiLine;
  // M6/M6-amd2: the frametime stat is NOT a line - it toggles the canvas
  // strip's AND the value line's visibility together (a fully-off line
  // writes '' into its KEPT div, but the strip + the number are HIDDEN -
  // an empty 31rem strip / a stale number would still occupy space).
  canvas.style.display = lines.frametimeEnabled ? '' : 'none';
  valueEl.style.display = lines.frametimeEnabled ? '' : 'none';
  // The value line: the latest derived frame time (max 2 decimals; the
  // honest '-' when the last poll had nothing to derive from).
  valueEl.textContent = lines.frametimeEnabled ? formatFrametime(latestFrameTime) : '';
  // M18/M19b: the header-divider column - the --overlay-label-w CSS var in
  // ch (WITH the unit - '4ch' / '9ch', never a bare number: a unit-less
  // value inside the calc is invalid at computed-value time) from the max
  // of the SIX labeled rows' labels (the chip-name labels widen the
  // column; the M19b api entry is 3ch - it never widens it; the CSS
  // calc's fallback holds the stock 4ch column before the first push).
  const maxLabelLen = Math.max(...Object.values(lines.labels).map((l) => l.length));
  document.documentElement.style.setProperty('--overlay-label-w', `${maxLabelLen}ch`);
  // M18/M19b: the divider's top/bottom - the FPS row's top to the API
  // row's bottom, relative to the root (measured like sizeCanvas() reads
  // the canvas rect - getBoundingClientRect, so it adapts to the scale and
  // to collapsed empty rows). M19b: the API row JOINED the divider column
  // - the line now spans fps -> api (the frametime strip stays BELOW the
  // divider's bottom).
  if (dividerEl) {
    const rootRect = rootEl.getBoundingClientRect();
    const fpsRect = fpsEl.getBoundingClientRect();
    const apiRect = apiEl.getBoundingClientRect();
    dividerEl.style.top = `${fpsRect.top - rootRect.top}px`;
    dividerEl.style.bottom = `${rootRect.bottom - apiRect.bottom}px`;
  }
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
  telemetryTicks += 1;
  document.documentElement.dataset.telemetryTicks = String(telemetryTicks);
  latestSample = sample;
  render();
});

// M3b: the fps poll runs on its OWN loop (the overlay keeps working when
// the main window is closed-to-tray - no dependency on the Monitoring
// page). The deviceId resolves via device-get at boot; the poll is SKIPPED
// when it is null (the no-Intel / fresh-store case - api.fpsPoll rejects on
// null via assertValidDeviceId) and the fps line honestly stays '-'.
// M17f: the cadence follows the overlayPollMs slider - ONE module-level
// interval, re-armed by the settings handler when the pushed value changes.
async function bootFpsLoop(): Promise<void> {
  try {
    const d = await api.deviceGet();
    fpsDeviceId = typeof d?.deviceId === 'number' && d.deviceId >= 0 ? d.deviceId : null;
  } catch {
    fpsDeviceId = null;
  }
  armFpsLoop();
}

/** M17f: the FPS-poll cadence (ms) - the overlayPollMs slider value; null
 *  until the first settings push -> the renderer's clamp default 400 ms
 *  (M17g: the stock polling rate FLIPS 500 -> 400; clampOverlayPollMs(null)
 *  - the real default, never a hardcoded copy).
 *  The settings handler calls applyFpsPollMs which re-arms the loop. */
let fpsPollMs: number | null = null;
/** The FPS-poll interval id (null = not armed). */
let fpsInterval: number | null = null;
/** The resolved FPS-poll device id (null until bootFpsLoop's device-get
 *  resolves - the arm stays a no-op until then). */
let fpsDeviceId: number | null = null;

/** M17f: (re-)arm the FPS-poll interval with the CURRENT cadence - the
 *  single arm path (boot + every settings push). The loop's interval
 *  callback reads the module-level fpsPollMs at arm time; the handler
 *  re-arms it via clearInterval + setInterval, never a second loop. */
function armFpsLoop(): void {
  if (fpsInterval !== null) {
    window.clearInterval(fpsInterval);
    fpsInterval = null;
  }
  if (fpsDeviceId === null) return;
  const pollMs = clampOverlayPollMs(fpsPollMs);
  fpsInterval = window.setInterval(() => {
    void (async () => {
      let sample: FpsSample | null = null;
      try {
        sample = await api.fpsPoll(fpsDeviceId as number);
      } catch {
        sample = null;
      }
      if (!sample) return;
      const fps = typeof sample.fps === 'number' ? sample.fps : null;
      latestFps = fps;
      // M7a: the 1% Low / 99% FPS stats ride the same poll (null when the
      // sample lacks them - the honest '-' on the FPS row).
      latestLow1Pct = typeof sample.low1Pct === 'number' ? sample.low1Pct : null;
      latestP99 = typeof sample.p99 === 'number' ? sample.p99 : null;
      // M12: the window AVG + the 0.1% Low ride the same poll (null when
      // the sample lacks them - the honest '-' on the FPS row).
      latestAvgFps = typeof sample.avgFps === 'number' ? sample.avgFps : null;
      latestLow01Pct = typeof sample.low01Pct === 'number' ? sample.low01Pct : null;
      // M10a/M13: the foreground-window Graphics-API id rides the same
      // poll (null when the sample lacks it - the API row stays empty;
      // the canonical labels are resolved by apiLabelOf in overlayLines).
      latestApi = typeof sample.api === 'string' ? sample.api : null;
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
  }, pollMs);
}

/** M17f: re-arm the FPS-poll interval when the pushed overlayPollMs changes
 *  (called from the settings handler - the SAME slider drives the telemetry
 *  push cadence AND the FPS poll). An unchanged value never re-arms (the
 *  duplicate-loop cautionary example - ONE loop, ONE interval). */
function applyFpsPollMs(ms: number): void {
  if (fpsPollMs === ms) return;
  fpsPollMs = ms;
  armFpsLoop();
}

void bootFpsLoop();

// M17b (2c): the boot NAMES fetch - api.listDevices() + api.sysinfo() ONCE
// (a NEW fetch - the bootFpsLoop deviceGet above is the FPS poll's device
// id, NOT a names fetch). The chip-name labels derive from the SY SINFO
// payload (the plain 'Intel(R) Arc(TM) A770 Graphics' primary video-
// controller name + cpu.name - the mock/real names the cut-down rules
// were pinned against); listDevices is the fallback ONLY when sysinfo has
// no controllers (the real IGCL device name cuts down the same way).
// Never throws: a failed fetch leaves the labels null -> the stock
// 'CPU '/'GPU ' prefixes (the honest degrade).
async function bootNamesFetch(): Promise<void> {
  try {
    let gpuName: unknown = null;
    let cpuName: unknown = null;
    const sysinfo = await api.sysinfo();
    const controllers = Array.isArray(sysinfo?.videoControllers) ? sysinfo.videoControllers : [];
    gpuName = controllers.length > 0 ? controllers[0].name : null;
    cpuName = sysinfo?.cpu?.name ?? null;
    if (!gpuName) {
      // The edge fallback: sysinfo without controllers -> the IGCL device
      // name (its real shape cuts down identically).
      try {
        const devices = await api.listDevices();
        gpuName = Array.isArray(devices) && devices.length > 0 ? devices[0].name : null;
      } catch { /* best effort */ }
    }
    gpuChipLabel = chipLabelGpu(gpuName);
    cpuChipLabel = chipLabelCpu(cpuName);
    if (chipNamesEnabled) render();
  } catch {
    // the labels stay null - the stock prefixes (never a crash at boot)
  }
}

void bootNamesFetch();
