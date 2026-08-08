// Arc Power - M4-D dashboard CPU/GPU-card model (pure, DOM-free; unit-tested).
//
// The cards render from the sysinfo:get payload (the CIM query result
// cached at boot in main; the mock fixture in --ui-verify). Every field
// degrades honestly to '-' when null - the card never invents a number.

import type { SysInfo, VideoControllerInfo } from '../types.ts';

/**
 * Format a byte count as a human size ('32 GB'), '-' when null.
 * M4-D2 (§5, user): the RAM amount ROUNDS UP to the next whole GiB -
 * 34293735424 (31.93 GiB) renders "32 GB", never a floored "31 GB"
 * (documented ceil semantics per the user's request; the ".0" decimal is
 * dropped). Sub-GiB amounts render as whole MiB (never a rounded-up "1 GB"
 * lie for a 512 MB stick).
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '-';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Math.ceil(gib)} GB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

/**
 * M4-H: the CPU card's kv rows (data-label -> text). Honest '-' per null field.
 * M4-D (user): the cores/threads and the RAM brand/size/speed are BUNDLED
 * into single rows ("4 Cores / 8 Threads", "G.Skill 32 GB @ 2400 MHz").
 * M4-D2 (§6): the clock half of the cores row is the LIVE frequency - it
 * moved OUT of this static model (the dashboard renders it from the
 * telemetry tick, "@ 4.3 GHz", updated in place).
 * M4-H: the memory row gains the RAM type ("G.Skill 32 GB DDR5 @ 6000 MHz")
 * and the speed half moves to its own `memoryFreq` piece (the dashboard
 * renders it in a `.kv-static-freq` span - the blue accent styling via its
 * OWN class sharing the kv-live-freq rule, never the kv-live-freq class
 * itself: the onUpdate querySelector takes the FIRST match in the card).
 * A new Caches row (L1/L2/L3/L4 amounts, KB -> "L1 1.4 MB" style) renders
 * only the levels the sysinfo payload carries.
 */
export interface CpuCardRows {
  cpu: string;
  coresClock: string;
  /** The memory bundle WITHOUT the speed piece ("G.Skill 32 GB DDR5"). */
  memory: string;
  /** The speed piece ("@ 6000 MHz") for the styled .kv-static-freq span;
   *  null when the payload carries no speed. */
  memoryFreq: string | null;
  /** "L1 256 KB - L2 1 MB - L3 6 MB - L4 128 MB" - only existing levels,
   *  '-' when none. M4-I: FILLED from the payload -> the known-CPU table ->
   *  the CIM fallback (fills-only), "N KB" below 1024 KB else whole-MB
   *  floor, separator ' - '. */
  caches: string;
}

/**
 * M4-H: the SMBIOS Type-17 memory-type codes (Win32_PhysicalMemory.
 * SMBIOSMemoryType) -> the display name. Correct Type-17 codes: 24=DDR3,
 * 26=DDR4, 27=LPDDR, 28=LPDDR2, 29=LPDDR3, 30=LPDDR4, 34=DDR5, 35=LPDDR5,
 * 32/33/36=HBM/HBM2/HBM3. Anything else (incl. 25=FBD2) is omitted (null) -
 * the UI never prints a wrong type. Every code is pinned by a unit test.
 */
export function ramMemoryType(code: number | null | undefined): string | null {
  if (typeof code !== 'number' || !Number.isFinite(code)) return null;
  switch (code) {
    case 24: return 'DDR3';
    case 26: return 'DDR4';
    case 27: return 'LPDDR';
    case 28: return 'LPDDR2';
    case 29: return 'LPDDR3';
    case 30: return 'LPDDR4';
    case 34: return 'DDR5';
    case 35: return 'LPDDR5';
    case 32: return 'HBM';
    case 33: return 'HBM2';
    case 36: return 'HBM3';
    default: return null;
  }
}

/**
 * M4-I: the KNOWN-CPU cache table - keyed by a WORD-BOUNDARY token of the
 * exact Win32_Processor name (the tokensOf regex - an exact token, never a
 * substring). Supplies ONLY the levels CIM cannot: L1 (Win32_Processor.
 * L1CacheSize is NULL on many boards) and L4 (NO OS source anywhere).
 * FILLS-ONLY: the payload's own l1-l4 fields always win.
 *
 * 5775C (i7-5775C, Broadwell - this machine, live-verified 2026-08-08):
 *   L1 64 KB/core x 4 = 256 KB (ARK/microarchitecture; the probe's
 *   Win32_CacheMemory smallest InstalledSize entry is 256 KB - consistent),
 *   L2 256 KB/core x 4 = 1024 KB (Win32_Processor.L2CacheSize 1024),
 *   L3 6 MB = 6144 KB (Win32_Processor.L3CacheSize 6144),
 *   L4 128 MB eDRAM = 131072 KB (ARK; no OS source - the table supplies it).
 * Every entry re-verified against the same sources before landing.
 */
export const KNOWN_CPU_CACHE_KB: Record<string, { l1CacheKb?: number; l2CacheKb?: number; l3CacheKb?: number; l4CacheKb?: number }> = {
  '5775c': { l1CacheKb: 256, l2CacheKb: 1024, l3CacheKb: 6144, l4CacheKb: 131072 },
};

/**
 * M4-I: the known-CPU table lookup - a word-boundary token of the exact
 * processor name ('Intel(R) Core(TM) i7-5775C CPU @ 3.30GHz' -> the
 * '5775c' token). Null when no entry matches.
 */
export function knownCpuCacheKb(cpuName: string | null | undefined): { l1CacheKb?: number; l2CacheKb?: number; l3CacheKb?: number; l4CacheKb?: number } | null {
  const tokens = new Set(String(cpuName ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const token of Object.keys(KNOWN_CPU_CACHE_KB)) {
    if (tokens.has(token)) return KNOWN_CPU_CACHE_KB[token];
  }
  return null;
}

/**
 * M4-I: FILL the cache levels from the three sources, fills-only (the
 * payload values ALWAYS win; the table + the CIM fallback supply only
 * ABSENT levels):
 *   a. the payload's own l1/l2/l3/l4 fields;
 *   b. the known-CPU table (word-boundary model token);
 *   c. the CIM fallback - L1 = the SMALLEST Win32_CacheMemory InstalledSize
 *      entry when present (hierarchy property: L1-total < L2 < L3; the
 *      SMBIOS Level numbers are unreliable, the SIZES are not); L4 comes
 *      only from the table (no OS source).
 * @returns {{ l1CacheKb: number|null, l2CacheKb: number|null, l3CacheKb: number|null, l4CacheKb: number|null }}
 */
export function fillCacheKb(sysinfo: SysInfo | null) {
  const cpu = sysinfo?.cpu;
  const known = knownCpuCacheKb(cpu?.name);
  const sizes = (Array.isArray(sysinfo?.cacheMemory) ? sysinfo.cacheMemory : [])
    .map((r) => r?.installedSizeKb)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const cimL1 = sizes.length > 0 ? Math.min(...sizes) : null;
  const pick = (payload: number | null | undefined, table: number | undefined, fallback: number | null = null): number | null => {
    if (typeof payload === 'number' && Number.isFinite(payload) && payload > 0) return payload;
    if (typeof table === 'number' && Number.isFinite(table) && table > 0) return table;
    return fallback;
  };
  return {
    l1CacheKb: pick(cpu?.l1CacheKb, known?.l1CacheKb, cimL1),
    l2CacheKb: pick(cpu?.l2CacheKb, known?.l2CacheKb),
    l3CacheKb: pick(cpu?.l3CacheKb, known?.l3CacheKb),
    l4CacheKb: pick(cpu?.l4CacheKb, known?.l4CacheKb),
  };
}

/**
 * M4-I: format one cache amount (KB) as "L1 256 KB" below 1024 KB, else
 * whole-MB FLOOR ("L2 1 MB", "L3 6 MB"). null -> null (the caller omits
 * the level entirely). The separator between levels is ' - ' (pinned in
 * the pure tests - the fixture's 1470 KB -> '1 MB' either way, so the
 * ui-verify pins alone cannot catch the rounding).
 */
export function cacheLine(label: string, kb: number | null | undefined): string | null {
  if (typeof kb !== 'number' || !Number.isFinite(kb) || kb <= 0) return null;
  if (kb < 1024) return `${label} ${kb} KB`;
  return `${label} ${Math.floor(kb / 1024)} MB`;
}

/**
 * Build the CPU-card rows from the sysinfo payload (null payload -> all
 * '-'). Cores/threads bundle: "4 Cores / 8 Threads" (physical cores
 * degrade to null in the os.cpus() fallback - never an estimate, so the
 * bundle shows the logical half only then). Memory bundle:
 * "G.Skill 32 GB DDR5 @ 6000 MHz" (the manufacturer + type + speed pieces
 * degrade to absent, never invented). Caches: only the levels the payload
 * carries (L4 has NO OS source - the CIM query cannot report it; the mock
 * fixture carries one so the row renders in verify).
 */
export function cpuCardRows(sysinfo: SysInfo | null): CpuCardRows {
  const cpu = sysinfo?.cpu;
  const ram = sysinfo?.ram;
  const coresPart = typeof cpu?.cores === 'number' && cpu.cores > 0 ? `${cpu.cores} Cores` : null;
  const threadsPart = typeof cpu?.threads === 'number' && cpu.threads > 0 ? `${cpu.threads} Threads` : null;
  const coreClockParts = [coresPart, threadsPart].filter(Boolean) as string[];
  const type = ramMemoryType(ram?.memoryType);
  const memParts = [
    typeof ram?.manufacturer === 'string' && ram.manufacturer.length > 0 ? ram.manufacturer : null,
    formatBytes(ram?.totalBytes),
    type,
  ].filter(Boolean) as string[];
  const freqPart = typeof ram?.speedMhz === 'number' && ram.speedMhz > 0 ? `@ ${ram.speedMhz} MHz` : null;
  // M4-I: the cache levels are FILLED (payload -> known-CPU table -> the
  // CIM Win32_CacheMemory fallback - fills-only) and joined with ' - '.
  const filled = fillCacheKb(sysinfo);
  const cacheParts = [
    cacheLine('L1', filled.l1CacheKb),
    cacheLine('L2', filled.l2CacheKb),
    cacheLine('L3', filled.l3CacheKb),
    cacheLine('L4', filled.l4CacheKb),
  ].filter((c): c is string => c !== null);
  return {
    cpu: typeof cpu?.name === 'string' && cpu.name.length > 0 ? cpu.name : '-',
    coresClock: coreClockParts.length > 0 ? coreClockParts.join(' / ') : '-',
    memory: memParts.length > 0 ? memParts.join(' ') : '-',
    memoryFreq: freqPart,
    caches: cacheParts.length > 0 ? cacheParts.join(' - ') : '-',
  };
}

/**
 * M4-I (B2): the shared VRAM-row value helper - the SAME ceil contract as
 * the backend's formatDeviceName (mirrored here - the renderer cannot
 * import the main-side module): >= 1 GiB -> "8GB" (CEIL to the next whole
 * GiB, the user's "round to the next number"), sub-GiB stays whole-MiB
 * floor ("512 MB"), + the memType CARRIED ON THE DEVICE PAYLOAD when known
 * ("8GB GDDR6" - no renderer-side table). The no-Intel branch passes the
 * OS controller's vramBytes with no memType -> "size (+ type when known)".
 * Null bytes -> '-'.
 */
export function vramRowValue(vramBytes: number | null | undefined, memType: string | null | undefined): string {
  if (typeof vramBytes !== 'number' || !Number.isFinite(vramBytes) || vramBytes <= 0) return '-';
  if (vramBytes >= 1024 ** 3) {
    const gib = Math.ceil(vramBytes / 1024 ** 3);
    const type = typeof memType === 'string' && memType.length > 0 ? ` ${memType}` : '';
    return `${gib}GB${type}`;
  }
  return `${Math.floor(vramBytes / 1024 ** 2)} MB`;
}

/**
 * M4-D (user): the ReBAR verdict for the GPU card pill. True -> green
 * "ReBAR on"; false -> red "ReBAR off"; null -> grey "ReBAR -".
 */
export interface RebarState {
  label: string;
  level: 'ok' | 'error' | 'unknown';
}

export function rebarState(controller: VideoControllerInfo | null | undefined): RebarState {
  if (controller?.rebarActive === true) return { label: 'ReBAR on', level: 'ok' };
  if (controller?.rebarActive === false) return { label: 'ReBAR off', level: 'error' };
  return { label: 'ReBAR -', level: 'unknown' };
}

/**
 * 1.0.1 no-Intel round: the OS GPU - the PRIMARY NON-BASIC video controller
 * of the sysinfo payload (the first controller that is not a
 * basic-display/Microsoft fallback adapter - the same pick
 * matchVideoController uses for a model-less device name). Null when the
 * payload has no usable controller (degraded sysinfo / nothing but basic
 * adapters). Pure, DOM-free, node-testable.
 * @param {SysInfo | null} sysinfo
 * @returns {{ name: string, vramBytes: number | null } | null}
 */
export function primaryVideoController(sysinfo: SysInfo | null): { name: string; vramBytes: number | null } | null {
  const controllers = Array.isArray(sysinfo?.videoControllers) ? sysinfo.videoControllers : [];
  const primary = controllers.find((c) => c.name && !/basic|microsoft/i.test(c.name));
  if (!primary?.name) return null;
  return {
    name: primary.name,
    vramBytes: typeof primary.vramBytes === 'number' && Number.isFinite(primary.vramBytes) && primary.vramBytes > 0
      ? primary.vramBytes
      : null,
  };
}
