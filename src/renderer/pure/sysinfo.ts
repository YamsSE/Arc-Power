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
 * (documented ceil semantics per the request; the ".0" decimal is
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
 * M4L (A): the memory speed renders in MHz with the '@ ' prefix ("@ 2400
 * MHz" - the M4-H format REVERTED; M4J's always-GHz rule is inverted, the
 * mock's 6000 MHz renders "@ 6000 MHz"). Null when the payload carries no
 * speed.
 */
export function ramFreqText(speedMhz: number | null | undefined): string | null {
  if (typeof speedMhz !== 'number' || !Number.isFinite(speedMhz) || speedMhz <= 0) return null;
  return `@ ${speedMhz} MHz`;
}

/**
 * M4N (B.1): the CPU core frequency in GHz with one decimal ('4.3' from
 * 4300 MHz) - the shared value helper of the dashboard + monitoring Core
 * Frequency tiles. Honest '-' for null/non-finite/<= 0 (a zero or negative
 * reading is not a real frequency - same degrade contract as formatBytes).
 */
export function ghzFreq(mhz: number | null | undefined): string {
  if (typeof mhz !== 'number' || !Number.isFinite(mhz) || mhz <= 0) return '-';
  return (mhz / 1000).toFixed(1);
}

/**
 * M4N (B.1): a byte count as GB with one decimal ('3.0' from 2971324416) -
 * the monitoring VRAM tile value (the M4M MiB tile's GB replacement).
 * Honest '-' for null/non-finite/<= 0.
 */
export function gbValue(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '-';
  return (bytes / 1e9).toFixed(1);
}

/**
 * M4J (B): the Mainboard manufacturer short-map - Win32_BaseBoard reports
 * the full legal names; the row renders the short brands. Unknown
 * manufacturers pass through unchanged (never a wrong claim).
 */
export const MAINBOARD_SHORT_MANUFACTURER: Record<string, string> = Object.freeze({
  'ASUSTeK COMPUTER INC.': 'ASUSTeK',
  'Gigabyte Technology': 'Gigabyte',
  'Micro-Star International': 'MSI',
  'MSI': 'MSI',
});

/**
 * M4J (B): the Mainboard row label - "ASUSTeK MAXIMUS VII RANGER" (short
 * manufacturer + product); the Product ALONE when the manufacturer is
 * unknown (not in the short-map) / absent; the short manufacturer alone
 * when the product is absent; '-' when neither exists.
 */
export function mainboardRow(sysinfo: SysInfo | null): string {
  const bb = sysinfo?.baseboard;
  const manufacturer = typeof bb?.manufacturer === 'string' && bb.manufacturer.length > 0 ? bb.manufacturer : null;
  const product = typeof bb?.product === 'string' && bb.product.length > 0 ? bb.product : null;
  if (!manufacturer && !product) return '-';
  // Unknown manufacturers are NOT passed through here - the plan: the
  // Product alone when the manufacturer is unknown (a full legal name
  // before a bare product would read as a wrong brand claim).
  const short = manufacturer ? (MAINBOARD_SHORT_MANUFACTURER[manufacturer] ?? null) : null;
  if (!short) return product ?? '-';
  return product ? `${short} ${product}` : short;
}

/**
 * M4-H: the CPU card's kv rows (data-label -> text). Honest '-' per null field.
 * M4-D: the cores/threads and the RAM brand/size/speed are BUNDLED
 * into single rows ("4 Cores / 8 Threads", "G.Skill 32 GB @ 2400 MHz").
 * M4-D2 (§6): the clock half of the cores row is the LIVE frequency - it
 * moved OUT of this static model (the dashboard renders it from the
 * telemetry tick, "@ 4.3 GHz", updated in place).
 * M4-H: the memory row gains the RAM type ("G.Skill 32 GB DDR5 @ 6000 MHz")
 * and the speed half moves to its own `memoryFreq` piece (the dashboard
 * renders it in a `.kv-static-freq` span - the blue accent styling via its
 * OWN class sharing the kv-live-freq rule, never the kv-live-freq class
 * itself: the onUpdate querySelector takes the FIRST match in the card).
 * M4J (B): the speed half was ALWAYS GHz ("@ 6.0 GHz" - one decimal); the
 * Cache row is REMOVED (a Mainboard row replaces it).
 * M4L (A): the speed half is INVERTED back to MHz ("@ 6000 MHz" - the
 * '@ ' prefix kept, the M4-H format restored).
 */
export interface CpuCardRows {
  cpu: string;
  coresClock: string;
  /** The memory bundle WITHOUT the speed piece ("G.Skill 32 GB DDR5"). */
  memory: string;
  /** The speed piece ("@ 6000 MHz") for the styled .kv-static-freq span;
   *  null when the payload carries no speed. */
  memoryFreq: string | null;
  /** M4J (B): the Mainboard row ("ASUSTeK MAXIMUS VII RANGER" - short-map
   *  manufacturer + product; product alone when unknown; '-' when none). */
  mainboard: string;
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
 * M4J (B): the KNOWN_CPU_CACHE_KB table, knownCpuCacheKb, fillCacheKb and
 * cacheLine are REMOVED with the Cache row (the M4-I known-CPU table is
 * gone - no dead pins).
 */

/**
 * Build the CPU-card rows from the sysinfo payload (null payload -> all
 * '-'). Cores/threads bundle: "4 Cores / 8 Threads" (physical cores
 * degrade to null in the os.cpus() fallback - never an estimate, so the
 * bundle shows the logical half only then). Memory bundle:
 * "G.Skill 32 GB DDR5 @ 6000 MHz" (the manufacturer + type + speed pieces
 * degrade to absent, never invented; the speed is MHz with the '@ '
 * prefix - M4L inverted the M4J GHz rule). Mainboard: "ASUSTeK MAXIMUS VII
 * RANGER" (short-map manufacturer + product; product alone when unknown).
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
  const freqPart = ramFreqText(ram?.speedMhz);
  return {
    cpu: typeof cpu?.name === 'string' && cpu.name.length > 0 ? cpu.name : '-',
    coresClock: coreClockParts.length > 0 ? coreClockParts.join(' / ') : '-',
    memory: memParts.length > 0 ? memParts.join(' ') : '-',
    memoryFreq: freqPart,
    mainboard: mainboardRow(sysinfo),
  };
}

/**
 * M4-I (B2): the shared VRAM-row value helper - the SAME ceil contract as
 * the backend's formatDeviceName (mirrored here - the renderer cannot
 * import the main-side module): >= 1 GiB -> "8GB" (CEIL to the next whole
 * GiB, the "round to the next number"), sub-GiB stays whole-MiB
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
 * M4-D: the ReBAR verdict for the GPU card pill. True -> green
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
 * M7b (fix 1): the REAL-GPU vendor predicate - the renderer mirror of the
 * main-side isRealGpuController (src/main/sysinfo.js - the same regexes,
 * defense in depth: the mock fixtures feed primaryVideoController too).
 * Keeps a controller only when its pnpDeviceId matches
 * /VEN_(8086|1002|10DE)/i (Intel / AMD / NVIDIA) OR its name matches
 * /intel|nvidia|radeon|geforce|arc|ati/i, and the name is NEVER
 * basic|microsoft (a "Microsoft Remote Display Adapter" must not pass on a
 * vendor-matching pnpDeviceId). Pure, DOM-free, node-testable.
 * @param {{ name?: string | null, pnpDeviceId?: string | null } | null | undefined} c
 */
export function isRealGpuController(c: { name?: string | null; pnpDeviceId?: string | null } | null | undefined): boolean {
  if (!c || typeof c !== 'object') return false;
  const name = typeof c.name === 'string' ? c.name : '';
  // NEVER basic|microsoft by name - the belt-and-braces exclusion.
  if (/basic|microsoft/i.test(name)) return false;
  const pnp = typeof c.pnpDeviceId === 'string' ? c.pnpDeviceId : '';
  return /VEN_(8086|1002|10DE)/i.test(pnp) || /intel|nvidia|radeon|geforce|arc|ati/i.test(name);
}

/**
 * 1.0.1 no-Intel round: the OS GPU - the PRIMARY REAL-GPU video controller
 * of the sysinfo payload (the first controller that passes the M7b
 * isRealGpuController predicate - the same pick matchVideoController uses
 * for a model-less device name). Null when the payload has no usable
 * controller (degraded sysinfo / nothing but basic adapters / DisplayLink
 * docks). Pure, DOM-free, node-testable.
 * @param {SysInfo | null} sysinfo
 * @returns {{ name: string, vramBytes: number | null } | null}
 */
export function primaryVideoController(sysinfo: SysInfo | null): { name: string; vramBytes: number | null } | null {
  const controllers = Array.isArray(sysinfo?.videoControllers) ? sysinfo.videoControllers : [];
  const primary = controllers.find((c) => c.name && isRealGpuController(c));
  if (!primary?.name) return null;
  return {
    name: primary.name,
    vramBytes: typeof primary.vramBytes === 'number' && Number.isFinite(primary.vramBytes) && primary.vramBytes > 0
      ? primary.vramBytes
      : null,
  };
}
