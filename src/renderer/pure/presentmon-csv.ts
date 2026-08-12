// Arc Power - M17c PresentMon CSV stream parser (pure, DOM-free; unit-tested
// in test/pure-presentmon-csv.test.ts - the cheap-oracle seam of the ETW/FPS
// lane).
//
// The ETW/PresentMon lane spawns the official PresentMon64.exe console
// sidecar per foreground-game pid with
//   --process_id <pid> --output_stdout --qpc_time_ms
// and parses its CSV stdout stream. This module extracts the FPS-relevant
// numbers; the sidecar spawn/wiring lives in Run C (fps-etw.js).
//
// The CSV columns are pinned from the official README
// (README-ConsoleApplication.md - the v2.x default metrics):
//   Application, ProcessID, SwapChainAddress, PresentRuntime, SyncInterval,
//   PresentFlags, AllowsTearing, PresentMode, FrameType, CPUStartTime,
//   MsCPUBusy, MsCPUWait, MsGPULatency, MsGPUTime, MsGPUBusy, MsGPUWait,
//   VideoBusy, DisplayLatency, DisplayedTime, MsAnimationError,
//   AnimationTime, MsClickToPhotonLatency, MsAllInputToPhotonLatency,
//   InstrumentedLatency, MsBetweenPresents, MsInPresentAPI,
//   MsBetweenDisplayChange, MsUntilDisplayed, MsRenderPresentLatency,
//   MsBetweenSimulationStart, MsPCLatency, MsBetweenAppStart
// (with --qpc_time_ms the CPUStartTime column is NAMED 'CPUStartQPCTime' -
// the value is the QPC counter converted to milliseconds).
//
// Semantics (per the README):
//   - 'Each row of the CSV represents a frame that an application rendered
//      and presented'; 'MsBetweenPresents: The time between this Present()
//      call and the previous one, in milliseconds' - the per-row fps =
//      1000 / msBetweenPresents;
//   - the row's ProcessID column carries the process attribution - only the
//     rows of the target pid are FPS-relevant (no window->adapter mapping);
//   - the msBetweenPresents column is a ROLLING AVERAGE per the README -
//     the parser windows the matching-pid rows over a ~1-second sub-window
//     (the rows whose timestamp falls within the newest sample's 1 s) and
//     averages the per-row rates, so a transient dropped frame cannot skew
//     the reported rate and the refresh-bound desktop ceiling is never
//     reported as the game's fps.
//
// Defensive: unknown/missing columns, an empty stream, a header mismatch,
// or a pid with no rows -> null (the caller degrades to the last-good rate -
// never a crash, never an invented fps). The header is matched NAME-BASED
// (never positional) - a PresentMon version that reorders or adds columns
// keeps parsing.

export interface PresentFpsResult {
  /** The fps over the 1-second window (1000 / mean msBetweenPresents). */
  fps: number;
  /** The msBetweenPresents of the NEWEST matching row (the rolling-average
   *  value the sidecar reported for the last frame). */
  lastSampleMs: number;
  /** The timestamp of the NEWEST matching row (the CPUStartQPCTime /
   *  CPUStartTime column - the row clock of the LAST present in the
   *  buffer). null when the stream carries no timestamp column. The
   *  fps-etw lane keys its dry-stream staleness on it: the 1-second parse
   *  window is keyed on the newest ROW's timestamp, not wall-clock, so a
   *  buffered re-parse keeps succeeding after the stream dries up -
   *  an UNCHANGED newestTs across ticks is the honest "no new presents"
   *  signal (step-4 S1). */
  newestTs: number | null;
}

/** The ProcessID column name (the process attribution). */
export const COL_PROCESS_ID = 'ProcessID';
/** The MsBetweenPresents column name (the per-row present interval). */
export const COL_MS_BETWEEN_PRESENTS = 'MsBetweenPresents';
/** The CPU-start timestamp column names: the --qpc_time_ms sidecar names it
 *  'CPUStartQPCTime'; the default PresentMon CSV names it 'CPUStartTime'.
 *  The windowing uses whichever exists; absent -> the whole matching set. */
const COL_TIMESTAMP = new Set(['CPUStartQPCTime', 'CPUStartTime']);
/** The 1-second window (ms) - the plan's window semantics for the rolling
 *  msBetweenPresents average. */
export const WINDOW_MS = 1000;

/** Split one CSV line into its fields - a quoted-field-tolerant split (the
 *  PresentMon column values carry no embedded commas/quotes today, but the
 *  parser stays honest on malformed quoting: a dangling quote is kept as
 *  the literal character, never a parse error). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toNumber(v: string): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * M17c: the PresentMon CSV stream -> the target pid's fps. HEADER-NAME-BASED
 * parsing (never positional): the header must carry ProcessID +
 * MsBetweenPresents (and a timestamp column for the windowing). Only the
 * rows matching `processId` count; the msBetweenPresents values window over
 * a 1-second sub-window (the rows at or within 1 s of the newest matching
 * sample) and fps = 1000 / the window's MEAN present interval (the column
 * is a rolling average per the README - per-row parse + window). Non-numeric
 * / 'NA' row values are skipped; an empty result (no rows / no usable
 * values / header mismatch / garbage) -> null.
 * @param {unknown} csvText the sidecar's CSV stdout (header + rows)
 * @param {unknown} processId the target process id (the --process_id value)
 * @returns {PresentFpsResult | null}
 */
export function presentFpsOfCsv(csvText: unknown, processId: unknown): PresentFpsResult | null {
  const pid = typeof processId === 'number' && Number.isFinite(processId) ? processId
    : (typeof processId === 'string' && processId.trim().length > 0 ? Number(processId) : NaN);
  if (!Number.isFinite(pid)) return null;
  if (typeof csvText !== 'string') return null;
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null; // a header + at least one row
  const header = splitCsvLine(lines[0]);
  const colPid = header.indexOf(COL_PROCESS_ID);
  const colMs = header.indexOf(COL_MS_BETWEEN_PRESENTS);
  if (colPid === -1 || colMs === -1) return null; // header mismatch
  const colTs = header.findIndex((h) => COL_TIMESTAMP.has(h.trim()));

  const rows: Array<{ ms: number; ts: number | null }> = [];
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    if (fields.length <= Math.max(colPid, colMs, colTs)) continue;
    if (fields[colPid].trim() !== String(pid)) continue;
    const ms = toNumber(fields[colMs]);
    if (ms === null || ms <= 0) continue; // 'NA' / garbage rows are skipped
    rows.push({ ms, ts: colTs >= 0 ? toNumber(fields[colTs]) : null });
  }
  if (rows.length === 0) return null; // the pid has no rows

  // The 1-second sub-window: the newest matching sample defines the window
  // end; only the rows within WINDOW_MS of it participate (the README's
  // rolling-average semantics - a transient dropped frame cannot skew the
  // reported rate). No timestamp column -> the whole matching set (the
  // honest degrade - still pid-filtered).
  let windowed = rows;
  const tsValues = rows.filter((r) => r.ts !== null).map((r) => r.ts as number);
  let newest = -Infinity;
  if (tsValues.length > 0) {
    newest = Math.max(...tsValues);
    windowed = rows.filter((r) => r.ts === null || r.ts >= newest - WINDOW_MS);
  }
  if (windowed.length === 0) windowed = rows;

  const meanMs = windowed.reduce((sum, r) => sum + r.ms, 0) / windowed.length;
  return {
    fps: 1000 / meanMs,
    lastSampleMs: rows[rows.length - 1].ms,
    newestTs: tsValues.length > 0 ? newest : null,
  };
}
