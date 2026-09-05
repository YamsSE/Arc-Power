// Arc Power - the shared compact, vendor-neutral GPU selector. Dashboard and
// Tuning both use the same all-device options; the selected device's
// capabilities decide whether Tuning controls are rendered.

import type { Store } from '../router.ts';
import { showDeviceSelector, deviceSelectorOptions } from '../pure/device.ts';
import { buildDropdown } from './dropdown.ts';

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
  return buildDropdown(String(s.deviceId ?? ''), options.map((o) => {
    const device = s.devices.find((candidate) => candidate.id === o.id);
    const stable = typeof device?.deviceKey === 'string'
      && device.deviceKey.length > 0
      && keyCounts.get(device.deviceKey) === 1;
    return {
      value: String(o.id),
      label: o.label,
      disabled: !stable,
    };
  }), {
    className: 'device-select',
    title: 'Select GPU',
    ariaLabel: 'Select GPU',
    onChange: (value) => {
      const id = Number(value);
      if (Number.isInteger(id)) onSwitch(id);
    },
  });
}

export function buildDeviceSelect(store: Store, onSwitch: (id: number) => void): HTMLElement | null {
  return buildSelect(store, onSwitch);
}
