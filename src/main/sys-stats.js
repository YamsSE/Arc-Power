// Arc Power — M4-D2 sys-stats module (electron-free).
//
// Four live system stats for the telemetry sample:
//   cpuUtilPct       — the FORMATTED "% Processor Time" — single sample of
//                      Win32_PerfFormattedData_Counters_ProcessorInformation
//                      (_Total instance). The OS already publishes it as
//                      0..100, so there is NO delta math (the raw-counter
//                      rolling delta was removed in fix round 2: on the
//                      live machine the raw _Total counters behave as a
//                      per-logical-processor accumulation — ~8× inflated,
//                      collapsed under load);
//   cpuFreqMhz       — round(MaxClockSpeed × "% Processor Performance" /
//                      100) — single sample of the SAME formatted class
//                      (fix round 2): freqFromPerfPct(fmtPerf, maxClock).
//                      The formatted counter is the honest frequency
//                      signal: on this BCLK-overclocked Z97 machine it
//                      reads 130 (load-invariant — the ratio is locked at
//                      33 and the bus at ~130 MHz), so the row shows
//                      round(3301 × 130 / 100) = 4291 MHz = the user's
//                      "4.3 GHz" (live-verified 2026-08-07). On machines
//                      where the counter caps at 100 the row honestly
//                      reads base × %-of-max (documented in the report);
//   cpuTempC         — Win32_PerfFormattedData_Counters_ThermalZoneInfo-
//                      mation Temperature (K×10 → °C; 0 → null); the max
//                      across all zones is reported (the hottest zone);
//   gpuMemUsedBytes  — Win32_PerfFormattedData_GPUPerformanceCounters_
//                      GPUAdapterMemory "DedicatedUsage" (bytes) for the
//                      instance whose name encodes the backend device's
//                      LUID ("luid_0x00000000_0x0000ADFB_phys_0" — live on
//                      the A770). The IGCL bindings expose NO adapter LUID
//                      (verified against igcl-bindings.js), so the LUID is
//                      resolved through the DXGI display enumeration link
//                      (fps-dxgi.js GetDesc1: DeviceId 0x56A0 → LUID
//                      0xADFB); null when unmatched.
//   cpuPowerW         — M4-H: the CPU package wattage from
//                      Win32_PerfFormattedData_PowerMeter_PowerMeter, the
//                      FORMATTED counter property 'Power' (already watts —
//                      no conversion). The class is often ABSENT on
//                      desktops (no power-metering hardware), so it
//                      honestly degrades to null ('—' in the UI).
//
// ONE PowerShell query per sample() reads every source at once (all
// single-sample formatted values — no cross-tick state, no deltas). A
// query in flight is never doubled (the previous result is served) — at
// most one PowerShell per tick. Any failure degrades per-field to null
// (honest '—' in the UI, never a crash).
//
// Mock mode (createMockSysStats): fixed deterministic values so ui-verify
// pins are stable; never spawns PowerShell.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * The per-tick CIM query: the _Total processor FORMATTED counters (the OS's
 * own 0..100 "% Processor Time" and the "% Processor Performance" frequency
 * signal), the thermal zones, the GPU adapter memory perf counters (the
 * instance names encode the adapter LUID) and the CPU's MaxClockSpeed (the
 * frequency multiplier). Serialized to JSON by PowerShell itself (the parse
 * side stays dumb); missing classes degrade to null/[].
 * @returns {string}
 */
export function buildSysStatsScript() {
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$cpu = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name=\'_Total\'" | Select-Object -First 1 Name,PercentProcessorTime,PercentProcessorPerformance',
    '$proc = Get-CimInstance Win32_Processor | Select-Object -First 1 MaxClockSpeed',
    '$tz = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | Select-Object Name,Temperature)',
    '$gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage)',
    // M4-H: the PowerMeter perf counter — the FORMATTED 'Power' property is
    // already in watts (N9). The class is often absent (no metering
    // hardware) -> null, the honest '—' degrade.
    '$pm = @(Get-CimInstance Win32_PerfFormattedData_PowerMeter_PowerMeter | Select-Object -First 1 Power)',
    '[pscustomobject]@{ cpu = $cpu; maxClockMhz = $proc.MaxClockSpeed; thermal = $tz; gpuMem = $gpu; powerMeter = $pm } | ConvertTo-Json -Depth 3 -Compress',
  ].join('; ');
}

/**
 * Parse the JSON output into the per-tick sample. Any missing piece
 * degrades to null / empty — the single-sample mapping below then reports
 * null honestly (fix round 2: the fields are the OS-formatted values, NOT
 * raw counters — no Timestamp_PerfTime is queried or parsed anymore).
 * @param {string} stdout
 * @returns {{
 *   fmtUtil: number | null, fmtPerf: number | null,
 *   maxClockMhz: number | null, tempK10Max: number | null,
 *   gpuMemRows: Array<{ name: string | null, dedicatedUsage: number | null }>,
 *   powerW: number | null,
 * }}
 */
export function parseSysStatsOutput(stdout) {
  let raw = null;
  try {
    raw = JSON.parse(String(stdout ?? ''));
  } catch {
    return { fmtUtil: null, fmtPerf: null, maxClockMhz: null, tempK10Max: null, gpuMemRows: [], powerW: null };
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cpu = raw?.cpu ?? {};
  const thermal = Array.isArray(raw?.thermal) ? raw.thermal : [];
  const temps = thermal
    .map((t) => num(t?.Temperature))
    .filter((t) => t !== null && t > 0);
  const gpuMemRows = (Array.isArray(raw?.gpuMem) ? raw.gpuMem : []).map((g) => ({
    name: typeof g?.Name === 'string' && g.Name ? g.Name : null,
    dedicatedUsage: num(g?.DedicatedUsage),
  }));
  return {
    fmtUtil: num(cpu.PercentProcessorTime),
    fmtPerf: num(cpu.PercentProcessorPerformance),
    maxClockMhz: num(raw?.maxClockMhz),
    tempK10Max: temps.length > 0 ? Math.max(...temps) : null,
    gpuMemRows,
    // M4-H: the PowerMeter's formatted 'Power' (watts); an absent class /
    // 0 reading degrades to null (the honest '—' — never a fake 0 W).
    powerW: num(raw?.powerMeter?.Power) > 0 ? num(raw?.powerMeter?.Power) : null,
  };
}

/**
 * The cpuFreqMhz single-sample mapping (fix round 2): the FORMATTED
 * "% Processor Performance" counter is a percentage of the max clock —
 * round(MaxClockSpeed × PercentProcessorPerformance / 100). On this
 * BCLK-overclocked machine: round(3301 × 130 / 100) = 4291 MHz (the
 * user's "4.3 GHz"). No delta math — the OS publishes the value directly.
 * Null when the percentage or the max clock is unknown.
 * @param {number | null} perfPct
 * @param {number | null} maxClockMhz
 * @returns {number | null}
 */
export function freqFromPerfPct(perfPct, maxClockMhz) {
  if (perfPct === null || maxClockMhz === null || maxClockMhz <= 0) return null;
  return Math.round((perfPct * maxClockMhz) / 100);
}

/**
 * The GPU instance-name matcher: the perf-counter instance names encode
 * the adapter LUID as "luid_0x<high:08X>_0x<low:08X>_phys<N>". Returns
 * true when the name starts with the LUID's encoded prefix (any phys
 * index — an adapter can expose several).
 * @param {string | null} instanceName
 * @param {{ high: number, low: number } | null} luid
 * @returns {boolean}
 */
export function instanceMatchesLuid(instanceName, luid) {
  if (!instanceName || !luid) return false;
  // The perf-counter names render the LUID in UPPERCASE hex
  // ("luid_0x00000000_0x0000ADFB_phys_0" — live on the A770).
  const prefix = `luid_0x${(luid.high >>> 0).toString(16).padStart(8, '0')}_0x${(luid.low >>> 0).toString(16).padStart(8, '0')}_phys_`;
  return instanceName.toLowerCase().startsWith(prefix);
}

/**
 * The real adapter. `luidOf` resolves the backend device's LUID through
 * the DXGI display enumeration link (fps-dxgi.js GetDesc1 — matched by
 * PCI device id); null when the device cannot be matched (gpuMem then
 * reports null honestly).
 * @param {{
 *   execFile?: typeof execFile,
 *   powershellExe?: string,
 *   luidOf?: (deviceIdHex: string) => Promise<{ high: number, low: number } | null>,
 *   deviceIdHex?: string | null,   // e.g. '0x56a0' — the backend device's PCI id
 * }} [deps]
 */
export function createSysStats(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const luidOf = deps.luidOf ?? (async () => null);
  const deviceIdHex = deps.deviceIdHex ?? null;
  let maxClockMhz = null; // cached Win32_Processor MaxClockSpeed
  let inflight = null;
  let last = { cpuUtilPct: null, cpuTempC: null, cpuFreqMhz: null, gpuMemUsedBytes: null, cpuPowerW: null };

  return {
    /**
     * Compute the four stats from the FORMATTED per-tick sample (single
     * samples — no cross-tick delta state; fix round 2 removed the raw
     * rolling deltas, which were garbage on the live machine).
     * Never throws: every failure degrades to null per-field (and the
     * previous result is served while a query is in flight — at most one
     * PowerShell at a time).
     * @returns {Promise<{ cpuUtilPct: number | null, cpuTempC: number | null, cpuFreqMhz: number | null, gpuMemUsedBytes: number | null, cpuPowerW: number | null }>}
     */
    async sample() {
      if (inflight) return last;
      inflight = true;
      try {
        const { stdout } = await exec(
          deps.powershellExe ?? POWERSHELL_EXE,
          ['-NoProfile', '-NonInteractive', '-Command', buildSysStatsScript()],
          { windowsHide: true, timeout: 10000 },
        );
        const raw = parseSysStatsOutput(stdout);
        if (raw.maxClockMhz !== null) maxClockMhz = raw.maxClockMhz;
        // Fix round 2: single samples of the OS-formatted counters.
        //   cpuUtilPct = "% Processor Time" (already 0..100 — no delta);
        //   cpuFreqMhz = round(MaxClockSpeed × "% Processor Performance" / 100)
        //   — on this BCLK-overclocked machine: round(3301 × 130 / 100) = 4291.
        const utilPct = raw.fmtUtil;
        const freqMhz = freqFromPerfPct(raw.fmtPerf, maxClockMhz);
        // GPU memory: the perf-counter instance whose name encodes the
        // device's LUID (resolved via DXGI GetDesc1 by PCI device id).
        let gpuBytes = null;
        if (deviceIdHex) {
          try {
            const luid = await luidOf(deviceIdHex);
            const row = raw.gpuMemRows.find((r) => instanceMatchesLuid(r.name, luid));
            if (row && row.dedicatedUsage !== null && row.dedicatedUsage >= 0) gpuBytes = row.dedicatedUsage;
          } catch {
            gpuBytes = null;
          }
        }
        last = {
          cpuUtilPct: utilPct,
          cpuFreqMhz: freqMhz,
          cpuTempC: raw.tempK10Max !== null ? raw.tempK10Max / 10 : null,
          gpuMemUsedBytes: gpuBytes,
          // M4-H: the PowerMeter's formatted 'Power' — watts, single
          // sample; null when the class is absent (honest '—').
          cpuPowerW: raw.powerW,
        };
        return last;
      } catch {
        // a stats failure degrades honestly — never breaks the tick
        return last;
      } finally {
        inflight = null;
      }
    },
  };
}

/**
 * The in-memory fixture — the default sysStats adapter for tests and
 * --ui-verify (fixed deterministic values, never spawns PowerShell).
 * M4-H: the fixture carries a fixed cpuPowerW (the PowerMeter pin — the
 * real adapter's sample shape includes it; the absent class degrades).
 * @param {{ cpuUtilPct?: number, cpuTempC?: number, cpuFreqMhz?: number, gpuMemUsedBytes?: number, cpuPowerW?: number }} [overrides]
 */
export function createMockSysStats(overrides = {}) {
  const fixed = {
    cpuUtilPct: 42,
    cpuTempC: 61,
    cpuFreqMhz: 4300,
    gpuMemUsedBytes: 2971324416, // ~2.77 GiB (the A770's live-ish dedicated usage)
    cpuPowerW: 125.5, // M4-H: the fixed PowerMeter fixture (watts)
    ...overrides,
  };
  return {
    async sample() {
      return { ...fixed };
    },
  };
}
