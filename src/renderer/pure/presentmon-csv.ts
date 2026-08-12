// Arc Power - M17c/M17d PresentMon CSV stream parser (pure, DOM-free;
// unit-tested in test/pure-presentmon-csv.test.ts - the cheap-oracle seam
// of the ETW/FPS lane).
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
//      1000 / msBetweenPresents (the CPU-present cadence);
//   - M17d: 'MsBetweenDisplayChange: The time between this frame being
//      displayed and the previous one, in milliseconds' - the DISPLAY
//      cadence (what IGS's overlay shows - the fps accuracy fix). The
//      parser PREFERS it when the header carries it (the display-cadence
//      basis); MsBetweenPresents is the fallback. The --exclude_dropped
//      semantics: the CALLER passes the flag (the sidecar then omits the
//      non-displayed frames from the stream - a row only exists when it
//      reached the display) - the parser just consumes the columns;
//   - the row's ProcessID column carries the process attribution - only the
//     rows of the target pid are FPS-relevant (no window->adapter mapping);
//   - the interval columns are ROLLING AVERAGES per the README - the parser
//     windows the matching-pid rows over a ~500 ms sub-window (the rows
//     whose timestamp falls within the newest sample's 500 ms) and averages
//     the per-row rates, so a transient dropped frame cannot skew the
//     reported rate and the refresh-bound desktop ceiling is never
//     reported as the game's fps. M17d: the window SHRINKS from 1 s to
//     ~500 ms (the lag gap - the display-cadence basis tracks the display
//     rate, not the CPU present rate).
//
// Defensive: unknown/missing columns, an empty stream, a header mismatch,
// or a pid with no rows -> null (the caller degrades to the last-good rate -
// never a crash, never an invented fps). The header is matched NAME-BASED
// (never positional) - a PresentMon version that reorders or adds columns
// keeps parsing.

export interface PresentFpsResult {
  /** The fps over the 500 ms window (1000 / mean interval). M17d: the
   *  interval is the DISPLAY cadence (MsBetweenDisplayChange) when the
   *  column exists, the CPU-present cadence (MsBetweenPresents) otherwise. */
  fps: number;
  /** The interval of the NEWEST matching row (the rolling-average value the
   *  sidecar reported for the last frame - the preferred cadence column). */
  lastSampleMs: number;
  /** The timestamp of the NEWEST matching row (the CPUStartQPCTime /
   *  CPUStartTime column - the row clock of the LAST present in the
   *  buffer). null when the stream carries no timestamp column. The
   *  fps-etw lane keys its dry-stream staleness on it: the 500 ms parse
   *  window is keyed on the newest ROW's timestamp, not wall-clock, so a
   *  buffered re-parse keeps succeeding after the stream dries up -
   *  an UNCHANGED newestTs across ticks is the honest "no new presents"
   *  signal (step-4 S1). */
  newestTs: number | null;
  /** M17d: the cadence basis that produced the fps - 'display' when the
   *  MsBetweenDisplayChange column was used, 'present' for the
   *  MsBetweenPresents fallback (the caller can surface the distinction
   *  honestly). */
  basis: 'display' | 'present';
}

/** The ProcessID column name (the process attribution). */
export const COL_PROCESS_ID = 'ProcessID';
/** The MsBetweenPresents column name (the per-row present interval - the
 *  CPU-present cadence, the M17c basis). */
export const COL_MS_BETWEEN_PRESENTS = 'MsBetweenPresents';
/** M17d: the MsBetweenDisplayChange column name (the per-row DISPLAY
 *  interval - the preferred fps basis: what IGS's overlay shows). */
export const COL_MS_BETWEEN_DISPLAY_CHANGE = 'MsBetweenDisplayChange';
/** The CPU-start timestamp column names: the --qpc_time_ms sidecar names it
 *  'CPUStartQPCTime'; the default PresentMon CSV names it 'CPUStartTime'.
 *  The windowing uses whichever exists; absent -> the whole matching set. */
const COL_TIMESTAMP = new Set(['CPUStartQPCTime', 'CPUStartTime']);
/** The window (ms) - M17d: ~500 ms (the plan's display-cadence window; the
 *  M17c 1-second window shrank - the lag gap). */
export const WINDOW_MS = 500;

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

/** Collect the matching-pid rows for one interval column index. */
function collectRows(lines: string[], pid: string, colPid: number, colMs: number, colTs: number): Array<{ ms: number; ts: number | null }> {
  const rows: Array<{ ms: number; ts: number | null }> = [];
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    if (fields.length <= Math.max(colPid, colMs, colTs)) continue;
    if (fields[colPid].trim() !== pid) continue;
    const ms = toNumber(fields[colMs]);
    if (ms === null || ms <= 0) continue; // 'NA' / garbage rows are skipped
    rows.push({ ms, ts: colTs >= 0 ? toNumber(fields[colTs]) : null });
  }
  return rows;
}

/**
 * M17c/M17d: the PresentMon CSV stream -> the target pid's fps.
 * HEADER-NAME-BASED parsing (never positional): the header must carry
 * ProcessID + an interval column. M17d: the interval is the DISPLAY
 * cadence (MsBetweenDisplayChange) when the header carries it - the fps
 * the IGS overlay shows - with MsBetweenPresents as the fallback when the
 * display column is absent OR yields no usable value (the pre-M17d basis
 * unchanged). Only the rows matching `processId` count; the interval
 * values window over a 500 ms sub-window (the rows at or within 500 ms of
 * the newest matching sample) and fps = 1000 / the window's MEAN interval
 * (the columns are rolling averages per the README - per-row parse +
 * window). Non-numeric / 'NA' row values are skipped; an empty result (no
 * rows / no usable values / header mismatch / garbage) -> null.
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
  if (colPid === -1) return null; // header mismatch
  const colMsPresents = header.indexOf(COL_MS_BETWEEN_PRESENTS);
  // M17d: prefer the DISPLAY-cadence column when the header carries it.
  const colMsDisplay = header.indexOf(COL_MS_BETWEEN_DISPLAY_CHANGE);
  const colTs = header.findIndex((h) => COL_TIMESTAMP.has(h.trim()));

  const finish = (rows: Array<{ ms: number; ts: number | null }>, basis: 'display' | 'present'): PresentFpsResult | null => {
    if (rows.length === 0) return null; // the pid has no usable rows
    // The 500 ms sub-window: the newest matching sample defines the window
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
      basis,
    };
  };

  // The display-cadence pass (the preferred basis).
  if (colMsDisplay >= 0) {
    const rows = collectRows(lines, String(pid), colPid, colMsDisplay, colTs);
    const out = finish(rows, 'display');
    if (out !== null) return out;
  }
  // The fallback: MsBetweenPresents (the pre-M17d basis) - used when the
  // display column is absent OR the stream carries no usable display-cadence
  // value (an --exclude_dropped stream with zero displayed frames).
  if (colMsPresents === -1) return null;
  return finish(collectRows(lines, String(pid), colPid, colMsPresents, colTs), 'present');
}
