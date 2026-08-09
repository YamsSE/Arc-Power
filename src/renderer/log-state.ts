// Arc Power - M4-D2 (§10): renderer-wide log-to-file + FPS state.
//
// The "Log to file" toggle lives in the BOOT-LEVEL telemetry subscription
// in app.ts (logging continues across page navigation - the telemetry push
// is global). This tiny module is the shared state:
//   - `monitorLogToFile` - the persisted toggle value (initialized at boot
//     from profiles-list; updated by the Settings toggle - M4M (G): the
//     Monitoring page's duplicate toggle is REMOVED);
//   - `latestFps` - the latest FPS known to the renderer (the Monitoring
//     page's 1 s poll updates it; the log line carries it best-effort).

let monitorLogToFile = false;
let latestFps: number | null = null;

export function setMonitorLogToFile(v: boolean): void {
  monitorLogToFile = v === true;
}

export function getMonitorLogToFile(): boolean {
  return monitorLogToFile;
}

export function setLatestFps(fps: number | null): void {
  latestFps = typeof fps === 'number' && Number.isFinite(fps) ? fps : null;
}

export function getLatestFps(): number | null {
  return latestFps;
}
