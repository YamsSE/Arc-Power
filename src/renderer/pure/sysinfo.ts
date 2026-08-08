// Arc Power — M4-D dashboard CPU/GPU-card model (pure, DOM-free; unit-tested).
//
// The cards render from the sysinfo:get payload (the CIM query result
// cached at boot in main; the mock fixture in --ui-verify). Every field
// degrades honestly to '—' when null — the card never invents a number.

import type { SysInfo, VideoControllerInfo } from '../types.ts';

/**
 * Format a byte count as a human size ('32 GB'), '—' when null.
 * M4-D2 (§5, user): the RAM amount ROUNDS UP to the next whole GiB —
 * 34293735424 (31.93 GiB) renders "32 GB", never a floored "31 GB"
 * (documented ceil semantics per the user's request; the ".0" decimal is
 * dropped). Sub-GiB amounts render as whole MiB (never a rounded-up "1 GB"
 * lie for a 512 MB stick).
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Math.ceil(gib)} GB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

/**
 * M4-H: the CPU card's kv rows (data-label -> text). Honest '—' per null field.
 * M4-D (user): the cores/threads and the RAM brand/size/speed are BUNDLED
 * into single rows ("4 Cores / 8 Threads", "G.Skill 32 GB @ 2400 MHz").
 * M4-D2 (§6): the clock half of the cores row is the LIVE frequency — it
 * moved OUT of this static model (the dashboard renders it from the
 * telemetry tick, "@ 4.3 GHz", updated in place).
 * M4-H: the memory row gains the RAM type ("G.Skill 32 GB DDR5 @ 6000 MHz")
 * and the speed half moves to its own `memoryFreq` piece (the dashboard
 * renders it in a `.kv-static-freq` span — the blue accent styling via its
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
  /** "L1 1.4 MB / L2 3.6 MB / L3 6.8 MB" — only existing levels, '—' when none. */
  caches: string;
}

/**
 * M4-H: the SMBIOS Type-17 memory-type codes (Win32_PhysicalMemory.
 * SMBIOSMemoryType) -> the display name. Correct Type-17 codes: 24=DDR3,
 * 26=DDR4, 27=LPDDR, 28=LPDDR2, 29=LPDDR3, 30=LPDDR4, 34=DDR5, 35=LPDDR5,
 * 32/33/36=HBM/HBM2/HBM3. Anything else (incl. 25=FBD2) is omitted (null) —
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
 * M4-H: format one cache amount (KB) as "L1 1.4 MB" — KB -> MB with one
 * decimal. null -> null (the caller omits the level entirely).
 */
export function cacheLine(label: string, kb: number | null | undefined): string | null {
  if (typeof kb !== 'number' || !Number.isFinite(kb) || kb <= 0) return null;
  return `${label} ${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Build the CPU-card rows from the sysinfo payload (null payload -> all
 * '—'). Cores/threads bundle: "4 Cores / 8 Threads" (physical cores
 * degrade to null in the os.cpus() fallback — never an estimate, so the
 * bundle shows the logical half only then). Memory bundle:
 * "G.Skill 32 GB DDR5 @ 6000 MHz" (the manufacturer + type + speed pieces
 * degrade to absent, never invented). Caches: only the levels the payload
 * carries (L4 has NO OS source — the CIM query cannot report it; the mock
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
  const cacheParts = [
    cacheLine('L1', cpu?.l1CacheKb),
    cacheLine('L2', cpu?.l2CacheKb),
    cacheLine('L3', cpu?.l3CacheKb),
    // L4 renders ONLY when the payload carries it (the CIM query never
    // does — the mock fixture does).
    cacheLine('L4', cpu?.l4CacheKb),
  ].filter((c): c is string => c !== null);
  return {
    cpu: typeof cpu?.name === 'string' && cpu.name.length > 0 ? cpu.name : '—',
    coresClock: coreClockParts.length > 0 ? coreClockParts.join(' / ') : '—',
    memory: memParts.length > 0 ? memParts.join(' ') : '—',
    memoryFreq: freqPart,
    caches: cacheParts.length > 0 ? cacheParts.join(' / ') : '—',
  };
}

/**
 * M4-D (user): the ReBAR verdict for the GPU card pill. True -> green
 * "ReBAR on"; false -> red "ReBAR off"; null -> grey "ReBAR —".
 */
export interface RebarState {
  label: string;
  level: 'ok' | 'error' | 'unknown';
}

export function rebarState(controller: VideoControllerInfo | null | undefined): RebarState {
  if (controller?.rebarActive === true) return { label: 'ReBAR on', level: 'ok' };
  if (controller?.rebarActive === false) return { label: 'ReBAR off', level: 'error' };
  return { label: 'ReBAR —', level: 'unknown' };
}

/**
 * 1.0.1 no-Intel round: the OS GPU — the PRIMARY NON-BASIC video controller
 * of the sysinfo payload (the first controller that is not a
 * basic-display/Microsoft fallback adapter — the same pick
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
