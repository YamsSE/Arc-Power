// Arc Power - M4-D2 Monitoring log-to-file writer (electron-free).
//
// Appends one CSV line per telemetry sample to
//   <Documents>\Arc Power\monitor-YYYYMMDD.csv
// The header row is written on the first open of each file. IO errors are
// reported as { ok: false, error } - the app NEVER crashes on a log write.
// The env knob RID_MOCK_LOG_DIR redirects the directory (ui-verify writes
// to a temp dir instead of the real Documents).

import fs from 'node:fs';
import path from 'node:path';

export const MONITOR_LOG_HEADER = [
  'timestamp', 'gpuClockMhz', 'memClockMhz', 'tempC', 'powerW', 'utilPct',
  'fanRpm', 'cpuUtilPct', 'cpuTempC', 'cpuFreqMhz', 'gpuMemUsedBytes', 'fps',
].join(',');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `"${value.join(';')}"`;
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {object} sample the full telemetry sample (the pushed fields +
 *   the 4 system-stats fields + fps)
 * @returns {string} one CSV line (no trailing newline)
 */
export function formatLogLine(sample) {
  const fields = [
    sample.t, sample.gpuClockMhz, sample.memClockMhz, sample.tempC,
    sample.powerW, sample.utilPct, sample.fanRpm, sample.cpuUtilPct,
    sample.cpuTempC, sample.cpuFreqMhz, sample.gpuMemUsedBytes, sample.fps,
  ];
  return fields.map(csvEscape).join(',');
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
        const file = path.join(resolveDir(), `monitor-${yyyymmdd}.csv`);
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
