// Arc Power - M4-D2 (§10): renderer-wide log-to-file + FPS state.
//
// The "Log to file" toggle lives in the BOOT-LEVEL telemetry subscription
// in app.ts (logging continues across page navigation - the telemetry push
// is global). This tiny module is the shared state:
//   - `monitorLogToFile` - the persisted toggle value (initialized at boot
//     from profiles-list; updated by the Monitoring page);
//   - `monitorLogMetrics` - the persisted field selection used by the
//     Monitoring Log to file card;
//   - `latestFps` - the latest FPS known to the renderer (the Monitoring
//     page's 1 s poll updates it; the log line carries it best-effort).

let monitorLogToFile = false;
let latestFps: number | null = null;
let latestFpsSample: Record<string, number | null> = { fps: null, frameTimeMs: null, avgFps: null, low1Pct: null, low01Pct: null, p99: null };

export const MONITOR_LOG_METRICS = [
  'gpu-util', 'gpu-clock', 'gpu-voltage', 'gpu-temperature', 'gpu-power', 'gpu-fan',
  'gpu-vram', 'gpu-memory-clock', 'gpu-vram-temperature',
  'cpu-util', 'cpu-clock', 'cpu-temperature', 'cpu-power',
  'system-memory', 'system-memory-capacity',
  'fps', 'frame-time', 'fps-average', 'fps-1-low', 'fps-0.1-low', 'fps-p99',
] as const;

const DEFAULT_MONITOR_LOG_METRICS = [...MONITOR_LOG_METRICS];
let monitorLogMetrics = new Set<string>(DEFAULT_MONITOR_LOG_METRICS);

export function setMonitorLogToFile(v: boolean): void {
  monitorLogToFile = v === true;
}

export function getMonitorLogToFile(): boolean {
  return monitorLogToFile;
}

export function setMonitorLogMetrics(metrics: string[] | null | undefined): void {
  if (!Array.isArray(metrics)) {
    monitorLogMetrics = new Set(DEFAULT_MONITOR_LOG_METRICS);
    return;
  }
  monitorLogMetrics = new Set(metrics.filter((metric) => (MONITOR_LOG_METRICS as readonly string[]).includes(metric)));
}

export function getMonitorLogMetrics(): string[] {
  return [...monitorLogMetrics];
}

export function setLatestFps(fps: number | null): void {
  latestFps = typeof fps === 'number' && Number.isFinite(fps) ? fps : null;
  latestFpsSample = { ...latestFpsSample, fps: latestFps };
}

export function getLatestFps(): number | null {
  return latestFps;
}

export function setLatestFpsSample(sample: Record<string, unknown> | null | undefined): void {
  const numeric = (key: string): number | null => typeof sample?.[key] === 'number' && Number.isFinite(sample[key] as number)
    ? sample[key] as number
    : null;
  latestFpsSample = {
    fps: numeric('fps'),
    frameTimeMs: numeric('frameTimeMs'),
    avgFps: numeric('avgFps'),
    low1Pct: numeric('low1Pct'),
    low01Pct: numeric('low01Pct'),
    p99: numeric('p99'),
  };
  latestFps = latestFpsSample.fps;
}

export function getLatestFpsSample(): Record<string, number | null> {
  return { ...latestFpsSample };
}

/** Remove fields that were not selected in Monitoring > Log to file. */
export function filterMonitorLogSample(sample: Record<string, unknown>): Record<string, unknown> {
  const enabled = monitorLogMetrics;
  const out = { ...sample };
  const drop = (metric: string, ...keys: string[]): void => {
    if (enabled.has(metric)) return;
    for (const key of keys) out[key] = null;
  };
  out.utilPct = sample.gpuUtilPct ?? sample.utilPct ?? null;
  drop('gpu-util', 'utilPct', 'gpuUtilPct');
  drop('gpu-clock', 'gpuClockMhz');
  drop('gpu-voltage', 'gpuVoltageV');
  drop('gpu-temperature', 'tempC');
  drop('gpu-power', 'powerW');
  drop('gpu-fan', 'fanRpm');
  drop('gpu-vram', 'gpuMemUsedBytes');
  drop('gpu-memory-clock', 'memClockMhz');
  drop('gpu-vram-temperature', 'vramTempC');
  drop('cpu-util', 'cpuUtilPct');
  drop('cpu-clock', 'cpuFreqMhz');
  drop('cpu-temperature', 'cpuTempC');
  drop('cpu-power', 'cpuPowerW');
  drop('system-memory', 'memoryUsedBytes');
  drop('system-memory-capacity');
  drop('fps', 'fps');
  drop('frame-time', 'frameTimeMs');
  drop('fps-average', 'avgFps');
  drop('fps-1-low', 'low1Pct');
  drop('fps-0.1-low', 'low01Pct');
  drop('fps-p99', 'p99');
  return out;
}
