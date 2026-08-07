// Arc Power — M4-D dashboard CPU/GPU-card model (pure, DOM-free; unit-tested).
//
// The cards render from the sysinfo:get payload (the CIM query result
// cached at boot in main; the mock fixture in --ui-verify). Every field
// degrades honestly to '—' when null — the card never invents a number.

import type { SysInfo, VideoControllerInfo } from '../types.ts';

/** Format a byte count as a human GB figure ('32.0 GB'), '—' when null. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * The CPU card's kv rows (data-label -> text). Honest '—' per null field.
 * M4-D (user): the cores/threads/clock and the RAM brand/size/speed are
 * BUNDLED into single rows ("4 Cores / 8 Threads @ 3300 MHz",
 * "G.Skill 32.0 GB @ 2400 MHz") — the two loose rows are gone.
 */
export interface CpuCardRows {
  cpu: string;
  coresClock: string;
  memory: string;
}

/**
 * Build the CPU-card rows from the sysinfo payload (null payload -> all
 * '—'). Cores/threads/clock bundle: "4 Cores / 8 Threads @ 3300 MHz"
 * (physical cores degrade to null in the os.cpus() fallback — never an
 * estimate, so the bundle shows the logical half only then, and the clock
 * drops out when unknown). Memory bundle: "G.Skill 32.0 GB @ 2400 MHz"
 * (the manufacturer + speed rows degrade to '—' pieces, never invented).
 */
export function cpuCardRows(sysinfo: SysInfo | null): CpuCardRows {
  const cpu = sysinfo?.cpu;
  const ram = sysinfo?.ram;
  const coresPart = typeof cpu?.cores === 'number' && cpu.cores > 0 ? `${cpu.cores} Cores` : null;
  const threadsPart = typeof cpu?.threads === 'number' && cpu.threads > 0 ? `${cpu.threads} Threads` : null;
  const clockPart = typeof cpu?.maxClockMhz === 'number' && cpu.maxClockMhz > 0 ? `@ ${cpu.maxClockMhz} MHz` : null;
  const coreClockParts = [coresPart, threadsPart, clockPart].filter(Boolean) as string[];
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

/** PCIe Gen number -> display label ("PCIe 4.0"), null when unknown. */
export function pcieGenLabel(gen: number | null | undefined): string | null {
  if (typeof gen !== 'number' || gen < 1 || gen > 5) return null;
  return `PCIe ${gen}.0`;
}

/**
 * M4-D (user): the GPU card's PCIe row — the CURRENTLY-USED link
 * ("PCIe 4.0 x16"), or '—' when the kernel does not populate the link
 * properties (live-verified: the A770 behind a PCIe switch reports the
 * unpopulated 1/1 pattern — the honest row never invents a link).
 */
export function pcieRow(controller: VideoControllerInfo | null | undefined): string {
  const pcie = controller?.pcie;
  if (!pcie) return '—';
  // The kernel's unpopulated-defaults pattern (1/1/1/1) must never render
  // as a real link (defense-in-depth — the main-side parse gates it too).
  if (pcie.currentGen === 1 && pcie.currentWidth === 1 && pcie.maxGen === 1 && pcie.maxWidth === 1) return '—';
  const gen = pcieGenLabel(pcie.currentGen);
  const width = typeof pcie.currentWidth === 'number' && pcie.currentWidth > 0 ? `x${pcie.currentWidth}` : null;
  if (!gen || !width) return '—';
  return `${gen} ${width}`;
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
