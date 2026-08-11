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
    // M4J (C): the MSAcpi ACPI-zone source (root\wmi namespace) - the
    // FIRST-precedence CPU-temp source; CurrentTemperature is Kelvin*10.
    // The class is EMPTY on this Z97 desktop (honest degrade to the perf
    // counter below).
    '$msa = @(Get-CimInstance -Namespace root\\wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object CurrentTemperature)',
    '$gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name,DedicatedUsage)',
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
 *   gpuMemRows: Array<{ name: string | null, dedicatedUsage: number | null }>,
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
 *   powershellExe?: string,
 *   luidOf?: (deviceIdHex: string) => Promise<{ high: number, low: number } | null>,
 *   deviceIdHex?: string | null,   // e.g. '0x56a0' - the backend device's PCI id
 *   msrReader?: {                   // M4L: the PawnIO MSR provider (optional)
 *     packageTempC: () => Promise<number | null>,
 *     packagePowerW: () => Promise<number | null>,
 *     status: () => string,
 *     describe: () => string,
 *     powerStatus?: () => string,   // M17b: the per-field power status
 *   } | null,
 *   onMsrDegrade?: (text: string) => void,  // M4L: once-per-session degrade note
 * }} [deps]
 */
export function createSysStats(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const luidOf = deps.luidOf ?? (async () => null);
  const deviceIdHex = deps.deviceIdHex ?? null;
  const msrReader = deps.msrReader ?? null;
  const onMsrDegrade = deps.onMsrDegrade ?? null;
  let maxClockMhz = null; // cached Win32_Processor MaxClockSpeed
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
  let last = { cpuUtilPct: null, cpuTempC: null, cpuFreqMhz: null, gpuMemUsedBytes: null, cpuPowerW: null, gpuUtilPct: null };

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

  return {
    /**
     * Compute the four stats from the FORMATTED per-tick sample (single
     * samples - no cross-tick delta state; fix round 2 removed the raw
     * rolling deltas, which were garbage on the live machine).
     * Never throws: every failure degrades to null per-field (and the
     * previous result is served while a query is in flight - at most one
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
        //   cpuUtilPct = "% Processor Time" (already 0..100 - no delta);
        //   cpuFreqMhz = round(MaxClockSpeed × "% Processor Performance" / 100)
        //   - on this BCLK-overclocked machine: round(3301 × 130 / 100) = 4291.
        const utilPct = raw.fmtUtil;
        const freqMhz = freqFromPerfPct(raw.fmtPerf, maxClockMhz);
        // GPU memory: the perf-counter instance whose name encodes the
        // device's LUID (resolved via DXGI GetDesc1 by PCI device id).
        let gpuBytes = null;
        let gpuUtil = null;
        if (deviceIdHex) {
          try {
            const luid = await luidOf(deviceIdHex);
            const row = raw.gpuMemRows.find((r) => instanceMatchesLuid(r.name, luid));
            if (row && row.dedicatedUsage !== null && row.dedicatedUsage >= 0) gpuBytes = row.dedicatedUsage;
            // M4-I (D1): the GPUEngine aggregation for the SAME LUID.
            gpuUtil = gpuUtilPctOf(raw.gpuEngRows, luid);
          } catch {
            gpuBytes = null;
            gpuUtil = null;
          }
        }
        // M4-I (C1)/M4J (C)/M4L (B4): the CPU temperature - the MSR provider
        // FIRST (the REAL package sensor via PawnIO: TjMax - DTS, bit-31
        // gated; null on any driver/AV problem), then the TWO WMI sources
        // with MSAcpi first (the root\wmi ACPI zones; empty on this box ->
        // the perf counter fallback). The MSR reading is the live sensor -
        // the frozenDrop NEVER applies to it (only the static WMI zones
        // must not masquerade as a CPU sensor; the per-field fallback still
        // trips it on the WMI-sourced value after 5 identical samples).
        let msrTemp = null;
        try {
          msrTemp = msrReader ? await msrReader.packageTempC() : null;
        } catch {
          msrTemp = null;
        }
        const tempK10 = raw.msaTempK10Max !== null ? raw.msaTempK10Max : raw.tempK10Max;
        const wmiTempC = tempK10 !== null ? tempK10 / 10 : null;
        tempWindow = [...tempWindow, wmiTempC].slice(-5);
        const tempC = msrTemp !== null ? msrTemp : frozenDrop(tempWindow);
        // M4-H/M4L (B4): the CPU wattage - the MSR RAPL provider FIRST (the
        // (dE x 2^-ESU) / dt delta; the first sample calibrates -> null),
        // then the PowerMeter's formatted 'Power' (watts, single sample);
        // null when both are unavailable (honest '-').
        let msrPower = null;
        try {
          msrPower = msrReader ? await msrReader.packagePowerW() : null;
        } catch {
          msrPower = null;
        }
        if (msrReader && msrTemp === null && msrPower === null) fireMsrDegrade();
        // M17b (N4): the per-field POWER degrade - the named AMD status
        // reaches the log on the POWER path ALONE (temp may keep working;
        // a frozen energy counter / MSR refusal must not hide behind a
        // working temp - the pre-M17b emit only fired when BOTH were null).
        if (msrReader && msrPower === null) fireMsrPowerDegrade();
        last = {
          cpuUtilPct: utilPct,
          cpuFreqMhz: freqMhz,
          cpuTempC: tempC,
          gpuMemUsedBytes: gpuBytes,
          // M4L (B4): the MSR RAPL wattage wins; the PowerMeter fallback.
          cpuPowerW: msrPower !== null ? msrPower : raw.powerW,
          // M4-I (D1): the OS GPU-utilization counter; null when
          // unpopulated (the honest '-').
          gpuUtilPct: gpuUtil,
        };
        return last;
      } catch {
        // a stats failure degrades honestly - never breaks the tick
        return last;
      } finally {
        inflight = null;
      }
    },
  };
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
 * DECIMAL - the 'RAM 12.4 GB' ui-verify pin; the fixture-WINS composition:
 * the telemetry emit sites prefer extra.memoryUsedBytes over the injected
 * detector, so the mock value rides the push while the null-returning
 * mock detector stays unrun).
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
  return {
    async sample() {
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
        cpuPowerW: noPowerMeter ? null : base.cpuPowerW,
        gpuUtilPct: base.gpuUtilPct,
        memoryUsedBytes: base.memoryUsedBytes,
      };
    },
  };
}
