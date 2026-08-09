// Arc Power - M4-D2 Monitoring log-to-file writer (electron-free).
//
// Appends one READABLE, ALIGNED line per telemetry sample to
//   <Documents>\Arc Power\monitor-YYYYMMDD.txt
// The line format is fixed-width monospace columns (right-aligned, ' | '
// separators, a '-' for null values) with a ONE-TIME header row per file
// (all 12 fields). The timestamp derives from sample.t (epoch SECONDS -
// the real telemetry's timeStamp) via Date(t*1000), formatted locally as
// "YYYY-MM-DD HH:MM:SS". IO errors are reported as { ok: false, error } -
// the app NEVER crashes on a log write. The env knob RID_MOCK_LOG_DIR
// redirects the directory (ui-verify writes to a temp dir instead of the
// real Documents).

import fs from 'node:fs';
import path from 'node:path';

// M4J (E): the 12 columns - key + fixed display width. The header is the
// column NAMES right-aligned to the same widths (the header + the data
// lines align in a monospace viewer). M4M (C): the VRAM-used column reads
// decimal GB ('gpuMemUsedGb', width 12 so the 12-char header still fits
// its column) - the payload key stays gpuMemUsedBytes (ipc-core/sys-stats);
// formatLogLine special-cases the cell.
const COLUMNS = [
  { key: 'timestamp', width: 19 }, // 'YYYY-MM-DD HH:MM:SS'
  { key: 'gpuClockMhz', width: 11 },
  { key: 'memClockMhz', width: 11 },
  { key: 'tempC', width: 5 },
  { key: 'powerW', width: 6 },
  { key: 'utilPct', width: 7 },
  { key: 'fanRpm', width: 6 },
  { key: 'cpuUtilPct', width: 10 },
  { key: 'cpuTempC', width: 8 },
  { key: 'cpuFreqMhz', width: 10 },
  { key: 'gpuMemUsedGb', width: 12 },
  { key: 'fps', width: 3 },
];

export const MONITOR_LOG_HEADER = COLUMNS.map((c) => c.key.padStart(c.width)).join(' | ');

const SEPARATOR = ' | ';

/** Format one epoch-seconds timestamp as local "YYYY-MM-DD HH:MM:SS". */
function formatTimestamp(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return null;
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One cell: '-' for null/undefined, right-aligned to the column width. */
function formatCell(value, width) {
  let text;
  if (value === null || value === undefined) {
    text = '-';
  } else if (Array.isArray(value)) {
    text = value.length > 0 ? value.join(';') : '-';
  } else if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    // M4J final-review nit: a float column must never overflow its width
    // (mock power floats like 38.79999999993015 break the column
    // alignment) - one decimal for the float columns.
    text = String(Number(value.toFixed(1)));
  } else {
    text = String(value);
  }
  return text.length >= width ? text : text.padStart(width);
}

/**
 * M4M (C): bytes -> decimal GB with ONE decimal, returned as a STRING
 * ('3.0' - a NUMBER would route through formatCell's float branch and lose
 * the trailing .0). Null/undefined -> null (the '-' cell).
 */
function formatGb(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  return (bytes / 1e9).toFixed(1);
}

/**
 * @param {object} sample the full telemetry sample (the pushed fields +
 *   the 4 system-stats fields + fps)
 * @returns {string} one aligned line (no trailing newline)
 */
export function formatLogLine(sample) {
  const cells = COLUMNS.map((c) => {
    if (c.key === 'timestamp') {
      const ts = formatTimestamp(sample.t);
      return ts === null ? '-'.padStart(c.width) : ts.padStart(c.width);
    }
    // M4M (C): the renamed cell formats the BYTES sample directly - a naive
    // sample[c.key] read ('gpuMemUsedGb') would produce 12 cells of '-' (the
    // payload key stays gpuMemUsedBytes).
    if (c.key === 'gpuMemUsedGb') {
      const gb = formatGb(sample.gpuMemUsedBytes);
      return gb === null ? '-'.padStart(c.width) : gb.padStart(c.width);
    }
    return formatCell(sample[c.key], c.width);
  });
  return cells.join(SEPARATOR);
}

/**
 * The writer: one line per append, the header on the first open of the
 * day's file. Never throws - every IO failure degrades to { ok: false }.
 * @param {{
 *   dir?: string,          // default: RID_MOCK_LOG_DIR ?? <Documents>\Arc Power
 *   getDocumentsDir?: () => string,  // injectable (tests/electron)
 *   now?: () => Date,      // injectable clock
 * }} [deps]
 */
export function createMonitorLog(deps = {}) {
  const getDocumentsDir = deps.getDocumentsDir ?? (() => {
    throw new Error('no documents dir provider');
  });
  const dir = deps.dir ?? null; // explicit dir wins (RID_MOCK_LOG_DIR / tests)
  const now = deps.now ?? (() => new Date());
  let currentFile = null; // { path, headerWritten }

  const resolveDir = () => {
    if (dir) return dir;
    const envDir = process.env.RID_MOCK_LOG_DIR;
    if (envDir) return envDir;
    return path.join(getDocumentsDir(), 'Arc Power');
  };

  return {
    /**
     * Append one sample line. { ok: false, error } on IO failure - never
     * throws.
     * @param {object} sample
     * @returns {Promise<{ ok: boolean, error?: string, file?: string }>}
     */
    async append(sample) {
      try {
        const d = now();
        const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const file = path.join(resolveDir(), `monitor-${yyyymmdd}.txt`);
        if (!currentFile || currentFile.path !== file) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          currentFile = { path: file, headerWritten: false };
        }
        if (!currentFile.headerWritten) {
          fs.appendFileSync(file, MONITOR_LOG_HEADER + '\n');
          currentFile.headerWritten = true;
        }
        fs.appendFileSync(file, formatLogLine(sample) + '\n');
        return { ok: true, file };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}
