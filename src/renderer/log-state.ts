// Arc Power - M4-D2 (§10): renderer-wide log-to-file + FPS state.
//
// The Monitoring "Log to file" toggle lives in the BOOT-LEVEL telemetry
// subscription in app.ts (logging continues across page navigation - the
// telemetry push is global). This tiny module is the shared state:
//   - `monitorLogToFile` - the persisted toggle value (initialized at boot
//     from profiles-list; updated by the Settings + Monitoring toggles);
//   - `currentLogFile` - the last log path reported by the monitor-log
//     append (the channel reports { ok, file } - the Monitoring page shows
//     it as the "current log path" line);
//   - `latestFps` - the latest FPS known to the renderer (the Monitoring
//     page's 1 s poll updates it; the log line carries it best-effort).

let monitorLogToFile = false;
let currentLogFile: string | null = null;
let latestFps: number | null = null;

export function setMonitorLogToFile(v: boolean): void {
  monitorLogToFile = v === true;
}

export function getMonitorLogToFile(): boolean {
  return monitorLogToFile;
}

export function setCurrentLogFile(p: string | null): void {
  currentLogFile = typeof p === 'string' && p.length > 0 ? p : null;
}

export function getCurrentLogFile(): string | null {
  return currentLogFile;
}

export function setLatestFps(fps: number | null): void {
  latestFps = typeof fps === 'number' && Number.isFinite(fps) ? fps : null;
}

export function getLatestFps(): number | null {
  return latestFps;
}
