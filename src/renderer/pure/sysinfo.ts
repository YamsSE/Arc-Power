// Arc Power — M4-D dashboard CPU card model (pure, DOM-free; unit-tested).
//
// The card renders from the sysinfo:get payload (the CIM query result
// cached at boot in main; the mock fixture in --ui-verify). Every field
// degrades honestly to '—' when null (the os.cpus() fallback has no
// physical-core count or RAM speed, the query itself can fail) — the card
// never invents a number.

import type { SysInfo } from '../types.ts';

/** Format a byte count as a human GB figure ('32.0 GB'), '—' when null. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** The CPU card's kv rows (data-label -> text). Honest '—' per null field. */
export interface CpuCardRows {
  cpu: string;
  cores: string;
  maxClock: string;
  memory: string;
  memorySpeed: string;
}

/**
 * Build the five CPU-card rows from the sysinfo payload (null payload ->
 * all '—'). Cores row: "20 physical · 28 logical" (physical cores degrade
 * to null in the os.cpus() fallback — never an estimate, so only the
 * logical half shows then); max clock "5600 MHz"; memory total from
 * totalBytes; memory speed "6000 MHz" or '—' when the query had no
 * ConfiguredClockSpeed.
 */
export function cpuCardRows(sysinfo: SysInfo | null): CpuCardRows {
  const cpu = sysinfo?.cpu;
  const ram = sysinfo?.ram;
  const parts = [
    typeof cpu?.cores === 'number' && cpu.cores > 0 ? `${cpu.cores} physical` : null,
    typeof cpu?.threads === 'number' && cpu.threads > 0 ? `${cpu.threads} logical` : null,
  ].filter(Boolean) as string[];
  return {
    cpu: typeof cpu?.name === 'string' && cpu.name.length > 0 ? cpu.name : '—',
    cores: parts.length > 0 ? parts.join(' · ') : '—',
    maxClock: typeof cpu?.maxClockMhz === 'number' && cpu.maxClockMhz > 0 ? `${cpu.maxClockMhz} MHz` : '—',
    memory: formatBytes(ram?.totalBytes),
    memorySpeed: typeof ram?.speedMhz === 'number' && ram.speedMhz > 0 ? `${ram.speedMhz} MHz` : '—',
  };
}
