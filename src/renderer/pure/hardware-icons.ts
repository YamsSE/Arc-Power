// Hardware-family artwork selection for the Dashboard cards.
//
// The returned keys are stable asset names, not display strings.  Matching is
// intentionally conservative for unknown vendors so a third-party or
// malformed hardware name never receives a misleading brand mark.

export type CpuIconKey =
  | 'intel-core'
  | 'intel-xeon'
  | 'amd-athlon'
  | 'amd-fx'
  | 'amd-ryzen-3'
  | 'amd-ryzen-5'
  | 'amd-ryzen-7'
  | 'amd-ryzen-9'
  | 'amd-threadripper';

export type GpuIconKey =
  | 'nvidia-quadro'
  | 'nvidia-gtx'
  | 'nvidia-rtx'
  | 'amd-radeon-pro'
  | 'amd-rx-vega'
  | 'amd-rx'
  | 'intel-arc'
  | 'intel-graphics';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Return the supplied CPU family's normalized icon key, or null if unknown. */
export function cpuIconKeyOf(name: unknown): CpuIconKey | null {
  const value = textOf(name);
  if (!value) return null;
  if (value.includes('threadripper')) return 'amd-threadripper';
  if (value.includes('xeon')) return 'intel-xeon';
  if (value.includes('athlon')) return 'amd-athlon';
  if (value.includes('fx-') || value.includes(' fx') || value.startsWith('fx')) return 'amd-fx';
  if (value.includes('ryzen')) {
    if (/(^|\s|-)9(?:\s|[-]|$)/.test(value) || value.includes('ryzen 9')) return 'amd-ryzen-9';
    if (/(^|\s|-)7(?:\s|[-]|$)/.test(value) || value.includes('ryzen 7')) return 'amd-ryzen-7';
    if (/(^|\s|-)5(?:\s|[-]|$)/.test(value) || value.includes('ryzen 5')) return 'amd-ryzen-5';
    if (/(^|\s|-)3(?:\s|[-]|$)/.test(value) || value.includes('ryzen 3')) return 'amd-ryzen-3';
  }
  if (value.includes('intel') || value.includes('core(tm)') || value.includes('core')) return 'intel-core';
  return null;
}

/**
 * Return the GPU family's normalized icon key.  Vendor metadata is used when
 * available, while the model name remains the fallback for CIM/OS-only rows.
 */
export function gpuIconKeyOf(name: unknown, vendor?: unknown): GpuIconKey | null {
  const value = textOf(name);
  const maker = textOf(vendor);
  if (!value && !maker) return null;

  if (value.includes('quadro')) return 'nvidia-quadro';
  if (value.includes('gtx')) return 'nvidia-gtx';
  if (value.includes('rtx')) return 'nvidia-rtx';
  if (value.includes('nvidia') || maker.includes('nvidia')) return null;

  if (value.includes('radeon pro') || value.includes('firepro') || value.includes('radeonpro')
    || maker.includes('radeon pro')) return 'amd-radeon-pro';
  if (value.includes('vega')) return 'amd-rx-vega';
  if (value.includes('amd') || value.includes('radeon') || maker.includes('amd') || maker.includes('ati')) {
    return 'amd-rx';
  }

  if (value.includes('arc') || maker.includes('intel')) return value.includes('arc') ? 'intel-arc' : 'intel-graphics';
  if (value.includes('intel')) return value.includes('arc') ? 'intel-arc' : 'intel-graphics';
  return null;
}

export function cpuIconPath(key: CpuIconKey | null): string | null {
  return key ? `./assets/device-icons/cpu/${key}.png` : null;
}

export function gpuIconPath(key: GpuIconKey | null): string | null {
  return key ? `./assets/device-icons/gpu/${key}.png` : null;
}
