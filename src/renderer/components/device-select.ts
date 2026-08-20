// Arc Power - the shared compact, vendor-neutral GPU selector. Dashboard and
// Tuning both use the same all-device options; the selected device's
// capabilities decide whether Tuning controls are rendered.

import { el } from '../dom.ts';
import type { Store } from '../router.ts';
import { showDeviceSelector, deviceSelectorOptions } from '../pure/device.ts';

function buildSelect(store: Store, onSwitch: (id: number) => void): HTMLElement | null {
  const s = store.get();
  if (!showDeviceSelector(s.devices)) return null;
  const options = deviceSelectorOptions(s.devices, s.deviceId);
  const keyCounts = new Map<string, number>();
  for (const device of s.devices) {
    if (typeof device.deviceKey === 'string' && device.deviceKey.length > 0) {
      keyCounts.set(device.deviceKey, (keyCounts.get(device.deviceKey) ?? 0) + 1);
    }
  }
  return el('select', {
    class: 'device-select',
    title: 'Select GPU',
    'aria-label': 'Select GPU',
    onchange: (e: Event) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (Number.isInteger(id)) onSwitch(id);
    },
  }, options.map((o) => {
    const device = s.devices.find((candidate) => candidate.id === o.id);
    const stable = typeof device?.deviceKey === 'string'
      && device.deviceKey.length > 0
      && keyCounts.get(device.deviceKey) === 1;
    const opt = el('option', { value: String(o.id), text: o.label }) as HTMLOptionElement;
    opt.disabled = !stable;
    if (!stable) opt.title = 'This GPU has no unique stable identity and cannot be selected safely.';
    if (o.selected) opt.selected = true;
    return opt;
  }));
}

export function buildDeviceSelect(store: Store, onSwitch: (id: number) => void): HTMLElement | null {
  return buildSelect(store, onSwitch);
}
