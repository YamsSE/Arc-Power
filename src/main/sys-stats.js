// Arc Power - M4-D2 sys-stats module (electron-free).
//
// Four live system stats for the telemetry sample:
//   cpuUtilPct       - the FORMATTED "% Processor Time" - single sample of
//                      Win32_PerfFormattedData_Counters_ProcessorInformation
//                      (_Total instance). The OS already publishes it as
//                      0..100, so there is NO delta math (the raw-counter
//                      rolling delta was removed in fix round 2: on the
//                      live machine the raw _Total counters behave as a
//                      per-logical-processor accumulation - ~8× inflated,
//                      collapsed under load);
//   cpuFreqMhz       - round(MaxClockSpeed × "% Processor Performance" /
//                      100) - single sample of the SAME formatted class
//                      (fix round 2): freqFromPerfPct(fmtPerf, maxClock).
//                      The formatted counter is the honest frequency
//                      signal: on this BCLK-overclocked Z97 machine it
//                      reads 130 (load-invariant - the ratio is locked at
//                      33 and the bus at ~130 MHz), so the row shows
//                      round(3301 × 130 / 100) = 4291 MHz = the
//                      "4.3 GHz" (live-verified 2026-08-07). On machines
//                      where the counter caps at 100 the row honestly
//                      reads base × %-of-max (documented in the report);
//   cpuTempC         - M4L (B4): the PawnIO MSR provider FIRST (the REAL
//                      package sensor: TjMax - DTS, bit-31 gated; null on
//                      any driver/AV problem), then the WMI fallback:
//                      1. MSAcpi_ThermalZoneTemperature (root\wmi,
//                         CurrentTemperature in Kelvin*10 - the ACPI thermal
//                         zones; present on many laptops, EMPTY on this
//                         Z97 desktop);
//                      2. Win32_PerfFormattedData_Counters_ThermalZoneInfo-
//                         mation Temperature (K*10 -> C; 0 -> null) - the
//                         perf counter fallback.
//                      The max across all zones of the chosen source is
//                      reported (the hottest zone); the shared frozenDrop
//                      (last 5 identical samples -> null) applies ONLY to
//                      the WMI sources (a static board zone must not
//                      masquerade as a CPU sensor) - the MSR reading is a
//                      live sensor and never trips it.
//   gpuMemUsedBytes  - Win32_PerfFormattedData_GPUPerformanceCounters_
//                      GPUAdapterMemory "DedicatedUsage" (bytes) for the
//                      instance whose name encodes the backend device's
//                      LUID ("luid_0x00000000_0x0000ADFB_phys_0" - live on
//                      the A770). The IGCL bindings expose NO adapter LUID
//                      (verified against igcl-bindings.js), so the LUID is
//                      resolved through the DXGI display enumeration link
//                      (fps-dxgi.js GetDesc1: DeviceId 0x56A0 → LUID
//                      0xADFB); null when unmatched.
//   cpuPowerW         - M4L (B4): the PawnIO MSR RAPL provider FIRST (the
//                      (dE x 2^-ESU) / dt package-energy delta; the first
//                      sample calibrates -> null), then the WMI fallback:
//                      Win32_PerfFormattedData_PowerMeter_PowerMeter, the
//                      FORMATTED counter property 'Power' (already watts -
//                      no conversion). The class is often ABSENT on
//                      desktops (no power-metering hardware), so it
//                      honestly degrades to null ('-' in the UI).
//   gpuUtilPct        - M4-I: the OS GPU-utilization counter - the
//                      Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
//                      rows for the matched LUID (aggregate: per (eng#,
//                      engtype) the MAX across the process rows, then SUM,
//                      cap 100). Null when the counter is unpopulated
//                      (every matched row's UtilizationPercentage is
//                      null/absent - honest '-'; live probe 2026-08-08 on
//                      the A770: the field is POPULATED but reads 0 on
//                      every row - an Intel-Arc driver quirk; the AMD
//                      tester's box may feed it for real).
//
// ONE PowerShell query per sample() reads every source at once (all
// single-sample formatted values - no cross-tick state, no deltas). A
// query in flight is never doubled (the previous result is served) - at
// most one PowerShell per tick. Any failure degrades per-field to null
// (honest '-' in the UI, never a crash).
//
// Mock mode (createMockSysStats): fixed deterministic values so ui-verify
// pins are stable; never spawns PowerShell. M4-I: the mock temperature
// VARIES (61/62 alternating) so the pins stay live, with the RID_MOCK_
// FROZEN_TEMP=1 knob returning a CONSTANT (the shared frozenDrop then
// reports '-' - the verifiable Z97-static-zone shape) and a RID_MOCK_
// NO_POWER_METER=1 knob (cpuPowerW null - the honest no-metering shape).
//
// M17g (the CPU fast lane - the measured 3.7 s query is the root cause of
// the CPU fields ignoring the overlay polling-rate slider): the adapter
// SPLITS into two lanes. The FAST lane (sampleFast) reads the per-tick
// NATIVE fields - cpuUtilPct via kernel32 GetSystemTimes deltas (koffi,
// the memory-util test-harness pattern; the FIRST sample is null - a
// delta needs two reads), cpuTempC + cpuPowerW via the EXISTING MSR/
// PawnIO reads (native - they must not wait behind the query) and
// memoryUsedBytes via the EXISTING GlobalMemoryStatusEx detector - never
// blocks, never spawns PowerShell. The SLOW lane (sampleSlow) is the
// existing PowerShell CIM query (unchanged semantics; the inflight guard
// stays) refreshing the remaining OS-counter fields (gpuMemUsedBytes /
// gpuUtilPct / cpuFreqMhz + the MSR-less WMI temp/power fallbacks) into
// the shared cache, on its own background timer (startSlowLane - the
// honest wording: a 2.5 s timer whose EFFECTIVE refresh is the query
// duration, ~3.7 s on this box; the inflight guard prevents overlap). The
// merged cache is FAST ?? SLOW - the fast native value wins per field over
// the cached slow value; the telemetry push samples the fast lane per
// tick and emits IMMEDIATELY (never awaits the query). The once-per-
// session MSR degrade notes (fireMsrDegrade/fireMsrPowerDegrade) MOVE
// WITH the MSR reads to the fast lane (a degrade must still fire, never
// lost in the move); the frozenDrop window STAYS with the slow-lane WMI
// temp fallbacks (the MSR reading is live - the drop never applies to it).

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import koffi from 'koffi';
import { dedicatedMemoryBytesOf } from './backend/units.js';

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
    // M4J (C): the MSAcpi ACPI-zone source (root\wmi namespace) - the
    // FIRST-precedence CPU-temp source; CurrentTemperature is Kelvin*10.
    // The class is EMPTY on this Z97 desktop (honest degrade to the perf
    // counter below).
    '$msa = @(Get-CimInstance -Namespace root\\wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object CurrentTemperature)',
    '$gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage,SharedUsage)',
    // M4-I: the GPUEngine rows (Name + UtilizationPercentage) - the OS
    // GPU-utilization counter. Instance names encode the adapter LUID +
    // the engine: "pid_12336_luid_0x00000000_0x0000ADFB_phys_0_eng_0_
    // engtype_3D" (live-verified 2026-08-08).
    '$gpuEng = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Select-Object Name,UtilizationPercentage)',
    // M4-H: the PowerMeter perf counter - the FORMATTED 'Power' property is
    // already in watts (N9). The class is often absent (no metering
    // hardware) -> null, the honest '-' degrade.
    '$pm = @(Get-CimInstance Win32_PerfFormattedData_PowerMeter_PowerMeter | Select-Object -First 1 Power)',
    '[pscustomobject]@{ cpu = $cpu; maxClockMhz = $proc.MaxClockSpeed; thermal = $tz; msaThermal = $msa; gpuMem = $gpu; gpuEng = $gpuEng; powerMeter = $pm } | ConvertTo-Json -Depth 3 -Compress',
  ].join('; ');
}

/**
 * Parse the JSON output into the per-tick sample. Any missing piece
 * degrades to null / empty - the single-sample mapping below then reports
 * null honestly (fix round 2: the fields are the OS-formatted values, NOT
 * raw counters - no Timestamp_PerfTime is queried or parsed anymore).
 * @param {string} stdout
 * @returns {{
 *   fmtUtil: number | null, fmtPerf: number | null,
 *   maxClockMhz: number | null, tempK10Max: number | null,
 *   msaTempK10Max: number | null,
 *   gpuMemRows: Array<{ name: string | null, dedicatedUsage: number | null, sharedUsage: number | null }>,
 *   gpuEngRows: Array<{ name: string | null, utilPct: number | null }>,
 *   powerW: number | null,
 * }}
 */
export function parseSysStatsOutput(stdout) {
  let raw = null;
  try {
    raw = JSON.parse(String(stdout ?? ''));
  } catch {
    return { fmtUtil: null, fmtPerf: null, maxClockMhz: null, tempK10Max: null, msaTempK10Max: null, gpuMemRows: [], gpuEngRows: [], powerW: null };
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const cpu = raw?.cpu ?? {};
  const thermal = Array.isArray(raw?.thermal) ? raw.thermal : [];
  const temps = thermal
    .map((t) => num(t?.Temperature))
    .filter((t) => t !== null && t > 0);
  // M4J (C): the MSAcpi root\wmi zones - CurrentTemperature in Kelvin*10
  // (same scale as the perf counter, so the same /10 conversion applies).
  const msaThermal = Array.isArray(raw?.msaThermal) ? raw.msaThermal : [];
  const msaTemps = msaThermal
    .map((t) => num(t?.CurrentTemperature))
    .filter((t) => t !== null && t > 0);
  const gpuMemRows = (Array.isArray(raw?.gpuMem) ? raw.gpuMem : []).map((g) => ({
    name: typeof g?.Name === 'string' && g.Name ? g.Name : null,
    dedicatedUsage: num(g?.DedicatedUsage),
    sharedUsage: num(g?.SharedUsage),
  }));
  // M4-I: the GPUEngine rows - UtilizationPercentage may be null/absent
  // (an unpopulated counter -> gpuUtilPct reports null, the honest '-').
  const gpuEngRows = (Array.isArray(raw?.gpuEng) ? raw.gpuEng : []).map((g) => ({
    name: typeof g?.Name === 'string' && g.Name ? g.Name : null,
    utilPct: num(g?.UtilizationPercentage),
  }));
  return {
    fmtUtil: num(cpu.PercentProcessorTime),
    fmtPerf: num(cpu.PercentProcessorPerformance),
    maxClockMhz: num(raw?.maxClockMhz),
    tempK10Max: temps.length > 0 ? Math.max(...temps) : null,
    msaTempK10Max: msaTemps.length > 0 ? Math.max(...msaTemps) : null,
    gpuMemRows,
    gpuEngRows,
    // M4-H: the PowerMeter's formatted 'Power' (watts); an absent class /
    // 0 reading degrades to null (the honest '-' - never a fake 0 W).
    powerW: num(raw?.powerMeter?.Power) > 0 ? num(raw?.powerMeter?.Power) : null,
  };
}

/**
 * The cpuFreqMhz single-sample mapping (fix round 2): the FORMATTED
 * "% Processor Performance" counter is a percentage of the max clock -
 * round(MaxClockSpeed × PercentProcessorPerformance / 100). On this
 * BCLK-overclocked machine: round(3301 × 130 / 100) = 4291 MHz (the
 * user's "4.3 GHz"). No delta math - the OS publishes the value directly.
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
 * index - an adapter can expose several).
 * @param {string | null} instanceName
 * @param {{ high: number, low: number } | null} luid
 * @returns {boolean}
 */
export function instanceMatchesLuid(instanceName, luid) {
  if (!instanceName || !luid) return false;
  // The perf-counter names render the LUID in UPPERCASE hex
  // ("luid_0x00000000_0x0000ADFB_phys_0" - live on the A770).
  const prefix = `luid_0x${(luid.high >>> 0).toString(16).padStart(8, '0')}_0x${(luid.low >>> 0).toString(16).padStart(8, '0')}_phys_`;
  return instanceName.toLowerCase().startsWith(prefix);
}

/**
 * Aggregate GPUAdapterMemory usage for one selected adapter. All matching
 * phys_N rows contribute finite, non-negative values; no first-row or ordinal
 * choice is made. SharedUsage is selected only for an explicitly integrated
 * or mobile target whose dedicated capacity is unavailable.
 * @param {Array<{name: string|null, dedicatedUsage: number|null, sharedUsage: number|null}>} rows
 * @param {{high: number, low: number}|null} luid
 * @param {{integrated?: boolean, mobile?: boolean, dedicatedCapacityBytes?: number|null}} target
 * @returns {{bytes: number, source: 'dedicated'|'shared'}|null}
 */
export function gpuMemoryUsageOf(rows, luid, target = {}) {
  if (!luid) return null;
  const integratedOrMobile = target?.integrated === true || target?.mobile === true;
  const hasDedicatedCapacity = dedicatedMemoryBytesOf(target?.dedicatedCapacityBytes, integratedOrMobile) !== null;
  const source = integratedOrMobile && !hasDedicatedCapacity ? 'shared' : 'dedicated';
  const field = source === 'shared' ? 'sharedUsage' : 'dedicatedUsage';
  let total = 0;
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!instanceMatchesLuid(row?.name, luid)) continue;
    const value = row?.[field];
    if (!Number.isFinite(value) || value < 0) continue;
    total += value;
    count += 1;
  }
  return count > 0 ? { bytes: total, source } : null;
}

/**
 * M4-I (C1): the shared FROZEN-zone drop - given the rolling window of the
 * last thermal samples, report null when the last 5 are IDENTICAL (a
 * static board zone, NOT a CPU sensor - the Z97 machine's thermal zones
 * report 301/303 Kx10 and NEVER change, so the "stuck 30" is exactly this
 * value; with no real CPU-temp source the honest answer is '-').
 * Otherwise the LATEST sample. Applies to the temperature only (the
 * wattage stays raw). Pure; shared by the real adapter AND the mock
 * (RID_MOCK_FROZEN_TEMP=1 makes the mock's constant temp trip it).
 * @param {Array<number|null>} lastSamples the rolling window (oldest
 *   first; the caller keeps the last 5)
 * @returns {number | null}
 */
export function frozenDrop(lastSamples) {
  const window = Array.isArray(lastSamples) ? lastSamples : [];
  if (window.length >= 5) {
    const first = window[0];
    if (first !== null && window.every((v) => v === first)) return null;
  }
  const last = window[window.length - 1];
  return typeof last === 'number' && Number.isFinite(last) ? last : null;
}

/**
 * M4-I (D1): the engine key of a GPUEngine instance name - per (eng#,
 * engtype) grouping key. The live name format (probed 2026-08-08):
 * "pid_12336_luid_0x00000000_0x0000ADFB_phys_0_eng_0_engtype_3D" (the
 * engtype half may be EMPTY: "eng_10_engtype_"). Unparseable names fall
 * back to the whole name (a distinct key - never a cross-engine merge).
 * @param {string | null} instanceName
 * @returns {string}
 */
export function engineKeyOf(instanceName) {
  const m = String(instanceName ?? '').match(/_eng_(\d+)_engtype_([A-Za-z0-9]*)/);
  return m ? `${m[2]}_${m[1]}` : String(instanceName ?? '');
}

/**
 * M4-I (D1): the engine-row LUID matcher - the GPUEngine names carry a
 * pid_<n>_ PREFIX ("pid_12336_luid_0x00000000_0x0000ADFB_phys_0_eng_0_
 * engtype_3D" - live-verified 2026-08-08), so the LUID half must match as
 * a SUBSTRING, never a startswith (the GPUAdapterMemory names start with
 * the LUID directly - instanceMatchesLuid stays for those).
 * @param {string | null} instanceName
 * @param {{ high: number, low: number } | null} luid
 * @returns {boolean}
 */
export function engineRowMatchesLuid(instanceName, luid) {
  if (!instanceName || !luid) return false;
  const encoded = `luid_0x${(luid.high >>> 0).toString(16).padStart(8, '0')}_0x${(luid.low >>> 0).toString(16).padStart(8, '0')}_phys_`;
  return instanceName.toLowerCase().includes(encoded);
}

/**
 * M4-I (D1): aggregate the GPUEngine rows for the matched LUID into one
 * utilization percentage - per (eng#, engtype) the MAX across the process
 * rows, then SUM the engine maxima, capped at 100. Null when the counter
 * is unpopulated (no matched rows, or every matched row's utilPct is
 * null/absent - the honest '-'; a populated-but-zero counter reports 0).
 * @param {Array<{ name: string | null, utilPct: number | null }>} rows
 * @param {{ high: number, low: number } | null} luid
 * @returns {number | null}
 */
export function gpuUtilPctOf(rows, luid) {
  const list = Array.isArray(rows) ? rows : [];
  if (!luid) return null;
  const matched = list.filter((r) => engineRowMatchesLuid(r.name, luid));
  if (matched.length === 0) return null;
  const byEngine = new Map();
  for (const r of matched) {
    if (typeof r?.utilPct !== 'number' || !Number.isFinite(r.utilPct)) continue;
    const key = engineKeyOf(r.name);
    byEngine.set(key, Math.max(byEngine.get(key) ?? 0, r.utilPct));
  }
  if (byEngine.size === 0) return null;
  const sum = [...byEngine.values()].reduce((a, b) => a + b, 0);
  return Math.min(100, sum);
}

/** Normalize the LUID shapes used by DXGI, koffi, JSON, and persisted GPU
 * inventory rows into the numeric pair consumed by the perf-counter matcher.
 * A missing/invalid identity must never fall through to an ordinal adapter. */
export function normalizeLuid(value) {
  if (value === null || value === undefined) return null;
  const part = (raw) => {
    if (typeof raw === 'bigint') {
      if (raw < 0n || raw > 0xffffffffn) return null;
      return Number(raw);
    }
    if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 && raw <= 0xffffffff ? raw : null;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const text = raw.trim();
    const parsed = /^0x[0-9a-f]+$/i.test(text)
      ? Number.parseInt(text.slice(2), 16)
      : /^[0-9]+$/.test(text)
        ? Number(text)
        : /^[0-9a-f]+$/i.test(text)
          ? Number.parseInt(text, 16)
          : NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed : null;
  };
  if (typeof value === 'string') {
    const match = value.trim().match(/^(.*?):(.*?)$/);
    if (!match) return null;
    const high = part(match[1]);
    const low = part(match[2]);
    return high === null || low === null ? null : { high: high >>> 0, low: low >>> 0 };
  }
  if (typeof value !== 'object') return null;
  const high = part(value.high ?? value.High ?? value.highPart ?? value.HighPart);
  const low = part(value.low ?? value.Low ?? value.lowPart ?? value.LowPart);
  return high === null || low === null ? null : { high: high >>> 0, low: low >>> 0 };
}

// ---------------------------------------------------------------------------
// M17g - the GetSystemTimes CPU-utilization reader (kernel32 via koffi)
// ---------------------------------------------------------------------------

// The FILETIME layout (Windows SDK winbase.h): two DWORDs - dwLowDateTime@0
// + dwHighDateTime@4 - one 64-bit count of 100-ns intervals since
// 1601-01-01, 8 bytes total. GetSystemTimes(idle, kernel, user) writes
// three of them; the kernel time INCLUDES the idle time.
export const FILETIME_SIZE = 8;
export const CPU_UTIL_IDLE_OFF = 0;
export const CPU_UTIL_KERNEL_OFF = 8;
export const CPU_UTIL_USER_OFF = 16;

// M17g: the SLOW-lane background cadence - a 2.5 s timer whose EFFECTIVE
// refresh is the query duration (~3.7 s on this box: PowerShell startup +
// the CIM classes). The inflight guard prevents overlap, so a query longer
// than the cadence skips the intermediate ticks - the honest wording: the
// slow-lane fields refresh at the query duration, never the timer.
export const SLOW_LANE_CADENCE_MS = 2500;

/**
 * M17g: the GetSystemTimes CPU-utilization reader (kernel32 via koffi -
 * the memory-util test-harness pattern: the koffi load sits behind the
 * injectable deps.load seam, so the success path + the failure degrades
 * are unit-testable without the real kernel32, and the scripted FILETIME
 * deltas come back EXACTLY).
 *
 * The delta math: over the window between two reads,
 *   busy  = (kernel - idle) + user   (the non-idle time)
 *   total = kernel + user
 *   util% = busy / total x 100
 * The FIRST read is null - a delta needs two reads (the honest '-' for
 * one tick). The deltas are computed in BigInt and converted to Number
 * AFTER the subtraction: the absolute FILETIME values are ~1.3e17 (far
 * above Number.MAX_SAFE_INTEGER 9.0e15), but a sub-second delta is small
 * and exact. Any failure path (load failure, a bad func, the call
 * returning FALSE, any koffi error, a zero-length window, an impossible
 * busy ratio) degrades to null - NEVER a throw (the fps-dxgi pattern).
 * @param {{
 *   load?: (name: string) => object,   // injectable koffi load (tests)
 * }} [deps]
 */
export function createCpuUtilReader(deps = {}) {
  const load = deps.load ?? ((name) => koffi.load(name));
  // The koffi func resolves LAZILY on the first read() (the
  // foreground-api probe pattern - a failed load degrades, never throws).
  let getSystemTimes = null;
  // The last successful read's FILETIMEs (BigInt - the delta baseline);
  // null until the first successful read (the baseline tick).
  let prev = null;
  const funcOf = () => {
    if (getSystemTimes !== null) return getSystemTimes;
    getSystemTimes = load('kernel32.dll').func('GetSystemTimes', 'int32', ['void*', 'void*', 'void*']);
    return getSystemTimes;
  };

  /**
   * The CPU utilization percent over the window since the previous
   * successful read - or null on the FIRST read (a delta needs two
   * reads) and on ANY failure (the honest degrade, NEVER a throw).
   * @returns {Promise<number | null>} 0..100 or null
   */
  const read = async () => {
    try {
      const fn = funcOf();
      // ONE 24-byte buffer holding the three FILETIMEs (idle@0,
      // kernel@8, user@16 - the CPU_UTIL_*_OFF layout); the kernel and
      // user pointers are the buffer's base + their offsets (koffi
      // address arithmetic - the same single-buffer style as the
      // memory-util MEMORYSTATUSEX; each FILETIME must be its own
      // pointer, kernel32 writes at the start of each).
      const buf = koffi.alloc('uint8', FILETIME_SIZE * 3);
      const base = koffi.address(buf);
      const ok = fn(buf, base + BigInt(CPU_UTIL_KERNEL_OFF), base + BigInt(CPU_UTIL_USER_OFF));
      if (!ok) return null; // GetSystemTimes returned FALSE
      const idle = koffi.decode(buf, CPU_UTIL_IDLE_OFF, 'uint64');
      const kernel = koffi.decode(buf, CPU_UTIL_KERNEL_OFF, 'uint64');
      const user = koffi.decode(buf, CPU_UTIL_USER_OFF, 'uint64');
      if (prev === null) {
        prev = { idle, kernel, user };
        return null; // the baseline - a delta needs two reads
      }
      const idleDelta = idle - prev.idle;
      const kernelDelta = kernel - prev.kernel;
      const userDelta = user - prev.user;
      prev = { idle, kernel, user };
      const total = Number(kernelDelta + userDelta);
      if (!(total > 0)) return null; // a zero-length window degrades
      const busy = Number(kernelDelta - idleDelta + userDelta);
      // An impossible busy ratio (outside [0, total] - a broken counter)
      // degrades honestly, never a fake util (the memory-util pattern).
      if (busy < 0 || busy > total) return null;
      return (busy / total) * 100;
    } catch {
      return null; // ANY koffi error resolves to the honest null
    }
  };

  return { read };
}

/**
 * The real adapter. `luidOf` resolves the backend device's LUID through
 * the DXGI display enumeration link (fps-dxgi.js GetDesc1 - matched by
 * PCI device id); null when the device cannot be matched (gpuMem then
 * reports null honestly).
 * M4L (B4): the MSR provider (createMsrReader) is tried FIRST for the CPU
 * temperature + wattage - the REAL package sensor via PawnIO (TjMax - DTS
 * and the RAPL delta). Each field falls back PER-FIELD to the WMI source
 * when the MSR reading is null (temp -> the frozen-drop-guarded zone
 * sources; power -> the PowerMeter counter). The driver open + module load
 * happen ONCE (lazy, inside the reader - never per tick); the single
 * PowerShell query stays the only WMI source. `onMsrDegrade` fires ONCE
 * with the reader's honest degrade text (the pawnio.eu download link)
 * when the MSR path is unavailable - the log surface for the honest note.
 * M17b (N4): the PER-FIELD POWER degrade - when the POWER reading alone
 * is null (temp may keep working - the AMD frozen-counter / MSR-refusal
 * shape), the reader's named power status (powerStatus()) reaches the
 * log through the SAME onMsrDegrade channel with a 'CPU wattage:'
 * prefix. The both-fields-null path keeps the session-level fireMsrDegrade
 * (never double-fired).
 * @param {{
 *   execFile?: typeof execFile,
 *   luidOf?: (deviceIdHex: string, bdf?: string|null) => Promise<{ high: number, low: number } | null>,
 *   deviceKey?: string|null,       // stable physical adapter identity
 *   pnpDeviceId?: string|null,     // Windows identity fallback
 *   pciVendorId?: string|null,     // PCI identity fallback
 *   deviceIdHex?: string | null,   // e.g. '0x56a0' - the backend device's PCI id
 *   bdf?: string | null,           // durable PCI/BDF bridge for same-model adapters
 *   msrReader?: {                   // M4L: the PawnIO MSR provider (optional)
 *     packageTempC: () => Promise<number | null>,
 *     packagePowerW: () => Promise<number | null>,
 *     status: () => string,
 *     describe: () => string,
 *     powerStatus?: () => string,   // M17b: the per-field power status
 *   } | null,
 *   onMsrDegrade?: (text: string) => void,  // M4L: once-per-session degrade note
 *   memoryUtil?: { detect: () => Promise<number | null> },  // M17g: the RAM
 *                                  // detector (GlobalMemoryStatusEx - the
 *                                  // EXISTING native path; the fast lane's
 *                                  // memoryUsedBytes source). The DEFAULT is
 *                                  // the null-returning detector (the
 *                                  // determinism seam); main.js wires the
 *                                  // real detector in the product path.
 *   cpuUtilReader?: { read: () => Promise<number | null> },  // M17g: the
 *                                  // GetSystemTimes reader; the DEFAULT is
 *                                  // createCpuUtilReader({ load: deps.load })
 *   load?: (name: string) => object,  // M17g: the injectable koffi load
 *                                  // (the cpu-util reader's test-harness seam)
 *   setInterval?: typeof setInterval,   // M17g: the slow-lane timer seam
 *   clearInterval?: typeof clearInterval,  // (injectable - the tests)
 * }} [deps]
 */
export function createSysStats(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const luidOf = deps.luidOf ?? (async () => null);
  let deviceIdHex = deps.deviceIdHex ?? null;
  let deviceBdf = deps.bdf ?? null;
  let luidOverride = deps.luid ?? null;
  let targetIntegrated = deps.integrated === true;
  let targetMobile = deps.mobile === true;
  let dedicatedCapacityBytes = deps.dedicatedCapacityBytes ?? deps.vramBytes ?? null;
  const msrReader = deps.msrReader ?? null;
  const onMsrDegrade = deps.onMsrDegrade ?? null;
  // M17g: the RAM detector (GlobalMemoryStatusEx - native). The DEFAULT is
  // the null-returning detector (the determinism seam); main.js wires the
  // real detector in the product path. The fast lane composes its result
  // into the pushed sample - the ipc-core emit-site composition is gone.
  const memoryUtil = deps.memoryUtil ?? { detect: async () => null };
  // M17g: the GetSystemTimes reader (kernel32 via koffi - the memory-util
  // pattern). The koffi load sits behind the injectable deps.load seam
  // (tests); an injected reader substitutes entirely (deps.cpuUtilReader -
  // the fast-lane merge tests).
  const cpuUtilReader = deps.cpuUtilReader ?? createCpuUtilReader({ load: deps.load });
  // M17g: the slow-lane background timer seam (injectable for the tests -
  // the default is the Node globals).
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  let maxClockMhz = null; // cached Win32_Processor MaxClockSpeed
  // M17g: the SHARED inflight guard - ONE PowerShell query at a time across
  // BOTH entry points: the legacy sample() delegate's inline seed AND
  // sampleSlow() (a sample() seed in flight makes a slow-lane tick serve
  // the stale cache, and a slow-lane query in flight makes sample() skip
  // its seed - both serve the cache instead of doubling the query).
  let inflight = null;
  // M4-I (C1): the rolling thermal window (last 5 samples) for the shared
  // frozenDrop - the Z97 static board zone trips it ('-' - no real CPU-temp
  // source on this machine; the plan's ground truth).
  let tempWindow = [];
  let msrDegradeFired = false;
  // M17b (N4): the per-field POWER degrade - its OWN once-flag (the power
  // path may degrade while temp keeps working; the AMD named status must
  // reach the log on the power path alone).
  let msrPowerDegradeFired = false;
  // M17g: the shared FAST??SLOW cache - the slow lane's fields, seeded by
  // sampleSlow (the PowerShell query). sampleFast merges its fresh native
  // reads over it (the fast value wins per field; the slow value shows
  // through while a fast field is null - the first GetSystemTimes sample
  // or an MSR-less machine).
  let laneCache = { cpuUtilPct: null, cpuTempC: null, cpuFreqMhz: null, gpuMemUsedBytes: null, gpuMemorySource: null, cpuPowerW: null, gpuUtilPct: null };
  // M17g: the shared timer has an optional startup owner so a canceled,
  // deferred start cannot stop a newer session's lane.
  let slowHandle = null;
  let slowOwner = undefined;
  let slowInflight = false;

  // M150: system counters are queried once, but the GPU fields are cached
  // per physical adapter.  The old adapter had one mutable target, so a
  // second overlay lane could only ever inherit the selected GPU's LUID,
  // memory and utilization.  Identity is deliberately based on the same
  // stable evidence as the inventory; numeric session ids are never used.
  const emptyLaneCache = () => ({
    cpuUtilPct: null,
    cpuTempC: null,
    cpuFreqMhz: null,
    gpuMemUsedBytes: null,
    gpuMemorySource: null,
    cpuPowerW: null,
    gpuUtilPct: null,
  });
  const targetSpecOf = (target = null) => {
    const controller = target?.osController ?? {};
    const pciVendorId = target?.pciVendorId ?? controller.pciVendorId ?? null;
    const pciDeviceId = typeof (target?.pciDeviceId ?? target?.deviceIdHex ?? controller.pciDeviceId) === 'string'
      ? (target.pciDeviceId ?? target.deviceIdHex ?? controller.pciDeviceId)
      : null;
    return {
      deviceKey: typeof target?.deviceKey === 'string' && target.deviceKey.trim() ? target.deviceKey.trim() : null,
      pnpDeviceId: target?.pnpDeviceId ?? controller.pnpDeviceId ?? null,
      pciVendorId,
      pciDeviceId,
      bdf: target?.bdf ?? controller.bdf ?? null,
      deviceIdHex: pciDeviceId,
      osLuid: normalizeLuid(target?.osLuid ?? controller.luid ?? null),
      integrated: target?.integrated === true,
      mobile: target?.mobile === true,
      dedicatedCapacityBytes: target?.vramBytes ?? controller.vramBytes ?? null,
    };
  };
  const identityText = (value) => typeof value === 'string' && value.trim()
    ? value.trim().replace(/[\u0000\s]+/g, '').toUpperCase()
    : null;
  const bdfText = (value) => {
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
    if (!value || typeof value !== 'object') return null;
    const bus = Number(value.bus);
    const device = Number(value.device);
    const fn = Number(value.function ?? value.func ?? 0);
    if ([bus, device, fn].every(Number.isInteger)) return `${bus}:${device}.${fn}`;
    return null;
  };
  const luidText = (value) => {
    const luid = normalizeLuid(value);
    return luid ? `${luid.high}:${luid.low}` : null;
  };
  const targetKeyOf = (target) => {
    const spec = targetSpecOf(target);
    if (spec.deviceKey) return `key:${identityText(spec.deviceKey)}`;
    const pnp = identityText(spec.pnpDeviceId);
    const bdf = bdfText(spec.bdf);
    const vendor = identityText(spec.pciVendorId);
    const pci = identityText(spec.pciDeviceId ?? spec.deviceIdHex);
    const luid = luidText(spec.osLuid);
    if (pnp || bdf || pci || luid) return `physical:${pnp ?? '-'}|${vendor ?? '-'}:${pci ?? '-'}|${bdf ?? '-'}|luid:${luid ?? '-'}`;
    return 'default';
  };
  const targetRecords = new Map();
  const ensureTargetRecord = (target = null) => {
    const spec = targetSpecOf(target);
    const key = targetKeyOf(spec);
    let record = targetRecords.get(key);
    if (!record) {
      record = { key, ...spec, cache: emptyLaneCache() };
      targetRecords.set(key, record);
    } else {
      Object.assign(record, spec);
    }
    return record;
  };
  let activeRecord = ensureTargetRecord({
    deviceKey: deps.deviceKey ?? null,
    pnpDeviceId: deps.pnpDeviceId ?? null,
    pciVendorId: deps.pciVendorId ?? null,
    pciDeviceId: deviceIdHex,
    bdf: deviceBdf,
    osLuid: luidOverride,
    integrated: targetIntegrated,
    mobile: targetMobile,
    vramBytes: dedicatedCapacityBytes,
  });
  laneCache = activeRecord.cache;

  // M4L (B4): the once-per-session MSR degrade note - fired when the MSR
  // provider reports an unavailable state (device absent, install failed,
  // AV quarantine) so the honest text (with the pawnio.eu link) reaches
  // the log exactly once, never per tick.
  const fireMsrDegrade = () => {
    if (msrDegradeFired || !msrReader || !onMsrDegrade) return;
    const st = msrReader.status();
    if (st === 'ready' || st === 'closed') return;
    msrDegradeFired = true;
    onMsrDegrade(msrReader.describe());
  };

  // M17b (N4): the once-per-session PER-FIELD power degrade - the named
  // AMD power status (energy-counter-frozen / amd-msr-unavailable)
  // reaches the log on the POWER path ALONE (temp may keep working). The
  // session-level fireMsrDegrade above is the both-fields-null surface;
  // this emit is gated on it NOT having fired (never double-logged).
  const fireMsrPowerDegrade = () => {
    if (msrPowerDegradeFired || msrDegradeFired || !msrReader || !onMsrDegrade) return;
    const detail = typeof msrReader.powerStatus === 'function' ? msrReader.powerStatus() : 'ready';
    if (detail === 'ready' || detail === 'closed') return;
    msrPowerDegradeFired = true;
    onMsrDegrade(`CPU wattage unavailable: ${detail} (the RAPL power path - temp may keep working)`);
  };

  async function sampleFastForRecord(record) {
    let util = null;
    try {
      util = await cpuUtilReader.read();
    } catch {
      util = null;
    }
    let msrTemp = null;
    let msrPower = null;
    try {
      msrTemp = msrReader ? await msrReader.packageTempC() : null;
    } catch {
      msrTemp = null;
    }
    try {
      msrPower = msrReader ? await msrReader.packagePowerW() : null;
    } catch {
      msrPower = null;
    }
    // M17g: the once-per-session MSR degrade notes move with the MSR reads.
    if (msrReader && msrTemp === null && msrPower === null) fireMsrDegrade();
    if (msrReader && msrPower === null) fireMsrPowerDegrade();
    let memBytes = null;
    try {
      memBytes = await memoryUtil.detect();
    } catch {
      memBytes = null;
    }
    return {
      ...record.cache,
      cpuUtilPct: util ?? record.cache.cpuUtilPct,
      cpuTempC: msrTemp ?? record.cache.cpuTempC,
      cpuPowerW: msrPower ?? record.cache.cpuPowerW,
      memoryUsedBytes: memBytes,
    };
  }

  let adapter = null; // M17g: the self-reference - slowTick drives the lane methods

  // The legacy sample() return: the merged sample in the PRE-M17g
  // six-field shape (the fast lane's memoryUsedBytes stays on sampleFast -
  // the legacy entry point keeps its old contract; the pre-M17g test pins
  // deepEqual this exact shape). The query-derived fields (util/freq/GPU)
  // ride from the seeded laneCache - the fast lane's GetSystemTimes never
  // existed in the legacy contract, so a legacy caller gets the OLD slow
  // single-query semantics; the MSR-first temp/power override matches the
  // old sample()'s inline MSR reads (sampleFast owns them + the degrade
  // notes - nothing duplicated here).
  const legacyMerged = async () => {
    const m = await adapter.sampleFast();
    return {
      cpuUtilPct: laneCache.cpuUtilPct,
      cpuTempC: m.cpuTempC,
      cpuFreqMhz: laneCache.cpuFreqMhz,
      gpuMemUsedBytes: laneCache.gpuMemUsedBytes,
      cpuPowerW: m.cpuPowerW,
      gpuUtilPct: laneCache.gpuUtilPct,
    };
  };

  return (adapter = {
    /**
     * LEGACY - the pre-M17g single-query entry point, retained as a
     * DELEGATE over the lanes (the drift hazard is gone: the MSR reads +
     * the once-per-session degrade notes live in sampleFast ALONE - the
     * fast lane owns them, nothing is duplicated here). The semantics
     * keep the pre-M17g contract: ONE PowerShell query per call - the
     * delegate seeds the slow lane inline (the SHARED inflight guard
     * serves the merged cache while any query is in flight) - and the OLD
     * slow single-query fields: the query-derived util/freq/GPU fields
     * with the MSR-first temp/power override, and NO memoryUsedBytes (the
     * fast lane's RAM field stays on sampleFast). The M17g telemetry push
     * NEVER calls this - it samples sampleFast per tick; the slow-lane
     * seeding in the product path stays on the background timer + the
     * immediate seed tick. A caller here gets the OLD slow single-query
     * cost (the honest legacy contract).
     * @returns {Promise<{ cpuUtilPct: number | null, cpuTempC: number | null, cpuFreqMhz: number | null, gpuMemUsedBytes: number | null, cpuPowerW: number | null, gpuUtilPct: number | null }>}
     */
    async sample() {
      // The SHARED inflight guard (see the declaration): a query in
      // flight - the delegate's own seed OR a slow-lane tick - serves the
      // merged cache, never a second PowerShell.
      if (inflight) return legacyMerged();
      await adapter.sampleSlow();
      return legacyMerged();
    },

    /**
     * M17g: the SLOW lane - the existing PowerShell CIM query (unchanged
     * semantics from the pre-M17g sample(): one query per call; the
     * inflight guard serves the cached result while a query is in flight
     * - the guard is SHARED with the legacy sample() delegate, so at
     * most ONE PowerShell runs at a time across both entry points). The
     * MSR reads are NOT here anymore - they moved to the fast lane; the
     * WMI temp fallbacks (with
     * the shared frozenDrop window) + the PowerMeter power stay here,
     * seeding the shared cache (the FAST??SLOW merge source).
     * @returns {Promise<{ cpuUtilPct: number | null, cpuTempC: number | null, cpuFreqMhz: number | null, gpuMemUsedBytes: number | null, cpuPowerW: number | null, gpuUtilPct: number | null }>}
     */
    async sampleSlow() {
      if (inflight) return laneCache;
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
        const utilPct = raw.fmtUtil;
        const freqMhz = freqFromPerfPct(raw.fmtPerf, maxClockMhz);
        // M4-I (C1)/M4J (C): the WMI CPU temperature (the MSAcpi zones
        // first, then the perf counter) - the shared frozenDrop window
        // STAYS with the slow-lane WMI fallbacks (the MSR reading in the
        // fast lane is live - the drop never applies to it).
        const tempK10 = raw.msaTempK10Max !== null ? raw.msaTempK10Max : raw.tempK10Max;
        const wmiTempC = tempK10 !== null ? tempK10 / 10 : null;
        tempWindow = [...tempWindow, wmiTempC].slice(-5);
        const common = {
          cpuUtilPct: utilPct,
          cpuFreqMhz: freqMhz,
          cpuTempC: frozenDrop(tempWindow),
          // M4-H: the PowerMeter's formatted 'Power' (watts, single
          // sample); null when the class is absent (honest '-').
          cpuPowerW: raw.powerW,
        };
        // M150: resolve every registered physical target against the SAME
        // query.  Each adapter keeps its own LUID/memory/utilization cache;
        // a selected-device switch cannot overwrite another overlay lane.
        for (const record of targetRecords.values()) {
          let gpuBytes = null;
          let gpuMemorySource = null;
          let gpuUtil = null;
          if (record.deviceIdHex || record.osLuid) {
            try {
              const luid = normalizeLuid(record.osLuid) ?? normalizeLuid(await luidOf(record.deviceIdHex, record.bdf));
              const memory = gpuMemoryUsageOf(raw.gpuMemRows, luid, {
                integrated: record.integrated,
                mobile: record.mobile,
                dedicatedCapacityBytes: record.dedicatedCapacityBytes,
              });
              if (memory) {
                gpuBytes = memory.bytes;
                gpuMemorySource = memory.source;
              }
              gpuUtil = gpuUtilPctOf(raw.gpuEngRows, luid);
            } catch {
              gpuBytes = null;
              gpuMemorySource = null;
              gpuUtil = null;
            }
          }
          record.cache = {
            ...common,
            gpuMemUsedBytes: gpuBytes,
            gpuMemorySource,
            gpuUtilPct: gpuUtil,
          };
        }
        laneCache = activeRecord.cache;
        return laneCache;
      } catch {
        // a stats failure degrades honestly - never breaks the tick
        return laneCache;
      } finally {
        inflight = null;
      }
    },

    /**
     * M17g: the FAST native lane - the per-tick native fields:
     * cpuUtilPct (kernel32 GetSystemTimes deltas - the FIRST sample is
     * null, a delta needs two reads), cpuTempC + cpuPowerW (the EXISTING
     * MSR/PawnIO reads - moved out of the slow query flow; they are
     * native and must not wait behind it) and memoryUsedBytes (the
     * EXISTING GlobalMemoryStatusEx detector). NEVER blocks, NEVER
     * spawns PowerShell. The returned sample is the MERGED cache:
     * FAST ?? SLOW - the fast native value wins per field over the cached
     * slow value (the cache seeded by sampleSlow); a null fast field (the
     * first GetSystemTimes sample / an MSR-less machine) honestly shows
     * the slow value.
     * @returns {Promise<{ cpuUtilPct: number | null, cpuTempC: number | null, cpuFreqMhz: number | null, gpuMemUsedBytes: number | null, cpuPowerW: number | null, gpuUtilPct: number | null, memoryUsedBytes: number | null }>}
     */
    async sampleFast() {
      return sampleFastForRecord(activeRecord);
    },

    // M150: fast native fields are shared in meaning but merged with the
    // selected physical adapter's slow cache.  This is the per-lane entry
    // point used by overlay and multi-device consumers.
    async sampleForTarget(target = null) {
      // A target without stable physical identity cannot be joined to a
      // per-adapter cache. Never let it observe the focused/default record;
      // secondary overlay callers must receive an honest empty lane.
      if (targetKeyOf(target) === 'default') return emptyLaneCache();
      const record = ensureTargetRecord(target);
      return sampleFastForRecord(record);
    },

    registerTarget(target = null) {
      return ensureTargetRecord(target).key;
    },

    setTarget(target = null) {
      const next = target === null
        ? ensureTargetRecord(null)
        : ensureTargetRecord(target);
      const same = next === activeRecord;
      activeRecord = next;
      laneCache = activeRecord.cache;
      if (same) return;
    },

    /**
     * M17g: start the SLOW-lane background timer (the existing PowerShell
     * query on its own cadence - the telemetry push NEVER awaits it
     * inline). The honest wording: a 2.5 s timer whose EFFECTIVE refresh
     * is the query duration (~3.7 s on this box - PowerShell startup +
     * the CIM classes); the inflight guard prevents overlap, so a query
     * longer than the cadence skips the intermediate ticks. Idempotent -
     * one timer per adapter (multiple telemetry sessions share it). An
     * immediate first tick seeds the shared cache (never blocks the
     * caller - the tick runs async).
     * @param {number} [cadenceMs] the injectable cadence (tests; the
     *   default is SLOW_LANE_CADENCE_MS)
     * @param {number} [owner] optional telemetry startup generation
     */
    startSlowLane(cadenceMs = SLOW_LANE_CADENCE_MS, owner = undefined) {
      if (slowHandle !== null) return; // idempotent - one timer per adapter
      slowOwner = owner;
      slowHandle = setIntervalFn(() => {
        void slowTick();
      }, cadenceMs);
      // An immediate first tick seeds the shared cache (never blocks the
      // caller - the tick runs async; the handle is assigned FIRST so the
      // seed tick passes the stop-guard in slowTick).
      void slowTick();
    },

    /**
     * M17g: stop the slow lane (the telemetry teardown). The in-flight
     * query (if any) finishes on its own; no new tick starts. Idempotent.
     * @param {number} [owner] optional telemetry startup generation
     */
    stopSlowLane(owner = undefined) {
      if (owner !== undefined && slowOwner !== owner) return;
      if (slowHandle === null) return;
      clearIntervalFn(slowHandle);
      slowHandle = null;
      slowOwner = undefined;
    },
  });

  // M17g: one slow-lane tick - the inflight-guard non-overlap: a tick
  // fired while a query is in flight is SKIPPED (a query longer than the
  // cadence skips the intermediate ticks - the effective refresh is the
  // query duration, documented). A tick after stopSlowLane is a no-op
  // too (the belt-and-braces re-arm guard - the interval itself is
  // cleared, but a queued tick must never start a query after the stop).
  async function slowTick() {
    if (slowHandle === null) return;
    if (slowInflight) return;
    slowInflight = true;
    try {
      await adapter.sampleSlow();
    } catch {
      // sampleSlow never throws - the guard stays for belt-and-braces
    } finally {
      slowInflight = false;
    }
  }
}

/**
 * The in-memory fixture - the default sysStats adapter for tests and
 * --ui-verify (fixed deterministic values, never spawns PowerShell).
 * M4-H: the fixture carries a fixed cpuPowerW (the PowerMeter pin - the
 * real adapter's sample shape includes it; the absent class degrades).
 * M4-I (C1): the mock temperature VARIES (61/62 alternating) so the pins
 * stay live - the shared frozenDrop NEVER trips on a varying window.
 * Knobs: RID_MOCK_FROZEN_TEMP=1 makes the temperature CONSTANT (after 5
 * identical samples frozenDrop reports null - the verifiable '-' pin);
 * RID_MOCK_NO_POWER_METER=1 makes cpuPowerW null (the honest no-metering
 * shape). The mock also emits a deterministic gpuUtilPct (D1 - the
 * no-Intel util tile reads it; the value matches utilPct 42).
 * M14: the fixture carries a fixed memoryUsedBytes 12400000000 (12.4 GB -
 * DECIMAL - the 'RAM 12.4 GB' ui-verify pin; the FAST lane carries the
 * field - the M17g move: the emit-site composition is replaced by the
 * fast-lane field, and the mock's sampleFast answers the fixture value
 * directly while the null-returning mock detector stays unrun).
 * M17g: the mock mirrors the fast + slow lanes - both return the SAME
 * fixed deterministic values (instant, never a background query), and the
 * mock NEVER returns a null first sample (unlike the real GetSystemTimes
 * lane, the fixture needs no baseline tick - the determinism pins stay).
 * @param {{ cpuUtilPct?: number, cpuTempC?: number, cpuFreqMhz?: number, gpuMemUsedBytes?: number, cpuPowerW?: number, gpuUtilPct?: number, memoryUsedBytes?: number }} [overrides]
 */
export function createMockSysStats(overrides = {}) {
  const frozen = process.env.RID_MOCK_FROZEN_TEMP === '1';
  const noPowerMeter = process.env.RID_MOCK_NO_POWER_METER === '1';
  let tick = 0;
  let tempWindow = [];
  const base = {
    cpuUtilPct: 42,
    cpuFreqMhz: 4300,
    gpuMemUsedBytes: 2971324416, // ~2.77 GiB (the A770's live-ish dedicated usage)
    cpuPowerW: 125.5, // M4-H: the fixed PowerMeter fixture (watts)
    gpuUtilPct: 42, // M4-I (D1): the fixed OS GPU-utilization fixture
    memoryUsedBytes: 12400000000, // M14: the fixed used-RAM fixture (12.4 GB - decimal)
    ...overrides,
  };
  const sampleOf = () => {
    // M4-I (C1): 61 on even ticks, 62 on odd - the pins stay LIVE (the
    // exact-value pins move to 61|62); RID_MOCK_FROZEN_TEMP=1 (or a
    // numeric cpuTempC override) returns a constant so the shared
    // frozenDrop trips to null ('-').
    const rawTemp = typeof overrides.cpuTempC === 'number'
      ? overrides.cpuTempC
      : frozen ? 61 : (tick % 2 === 0 ? 61 : 62);
    tick += 1;
    tempWindow = [...tempWindow, rawTemp].slice(-5);
    return {
      cpuUtilPct: base.cpuUtilPct,
      cpuTempC: frozenDrop(tempWindow),
      cpuFreqMhz: base.cpuFreqMhz,
      gpuMemUsedBytes: base.gpuMemUsedBytes,
      gpuMemorySource: base.gpuMemorySource ?? 'dedicated',
      cpuPowerW: noPowerMeter ? null : base.cpuPowerW,
      gpuUtilPct: base.gpuUtilPct,
      memoryUsedBytes: base.memoryUsedBytes,
    };
  };
  return {
    // M17g: the fast + slow lanes return the SAME fixed deterministic
    // values (both instant - the fixture never needs a background
    // query). The mock NEVER returns a null first sample (the
    // determinism pins stay - no GetSystemTimes baseline tick here).
    async sampleFast() { return sampleOf(); },
    async sampleForTarget() { return sampleOf(); },
    registerTarget() {},
    async sampleSlow() { return sampleOf(); },
    async sample() { return sampleOf(); },
    // M17g: the mock needs no background slow lane (every call returns
    // the fixed values instantly) - the lifecycle seam exists for the
    // telemetry-session parity (the push starts/stops it like the real
    // adapter; the pins never depend on a timer).
    startSlowLane() {},
    stopSlowLane() {},
  };
}
