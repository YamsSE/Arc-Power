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
 * The CPU card's kv rows (data-label -> text). Honest '—' per null field.
 * M4-D (user): the cores/threads and the RAM brand/size/speed are BUNDLED
 * into single rows ("4 Cores / 8 Threads", "G.Skill 32 GB @ 2400 MHz").
 * M4-D2 (§6): the clock half of the cores row is the LIVE frequency — it
 * moved OUT of this static model (the dashboard renders it from the
 * telemetry tick, "@ 4.3 GHz", updated in place).
 */
export interface CpuCardRows {
  cpu: string;
  coresClock: string;
  memory: string;
}

/**
 * Build the CPU-card rows from the sysinfo payload (null payload -> all
 * '—'). Cores/threads bundle: "4 Cores / 8 Threads" (physical cores
 * degrade to null in the os.cpus() fallback — never an estimate, so the
 * bundle shows the logical half only then). Memory bundle:
 * "G.Skill 32 GB @ 2400 MHz" (the manufacturer + speed rows degrade to '—'
 * pieces, never invented).
 */
export function cpuCardRows(sysinfo: SysInfo | null): CpuCardRows {
  const cpu = sysinfo?.cpu;
  const ram = sysinfo?.ram;
  const coresPart = typeof cpu?.cores === 'number' && cpu.cores > 0 ? `${cpu.cores} Cores` : null;
  const threadsPart = typeof cpu?.threads === 'number' && cpu.threads > 0 ? `${cpu.threads} Threads` : null;
  const coreClockParts = [coresPart, threadsPart].filter(Boolean) as string[];
  const memParts = [
    typeof ram?.manufacturer === 'string' && ram.manufacturer.length > 0 ? ram.manufacturer : null,
    formatBytes(ram?.totalBytes),
    typeof ram?.speedMhz === 'number' && ram.speedMhz > 0 ? `@ ${ram.speedMhz} MHz` : null,
  ].filter(Boolean) as string[];
  return {
    cpu: typeof cpu?.name === 'string' && cpu.name.length > 0 ? cpu.name : '—',
    coresClock: coreClockParts.length > 0 ? coreClockParts.join(' / ') : '—',
    memory: memParts.length > 0 ? memParts.join(' ') : '—',
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
