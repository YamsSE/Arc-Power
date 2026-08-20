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
  return el('select', {
    class: 'device-select',
    title: 'Select GPU',
    'aria-label': 'Select GPU',
    onchange: (e: Event) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (Number.isInteger(id)) onSwitch(id);
    },
  }, options.map((o) => {
    const opt = el('option', { value: String(o.id), text: o.label });
    if (o.selected) opt.selected = true;
    return opt;
  }));
}

export function buildDeviceSelect(store: Store, onSwitch: (id: number) => void): HTMLElement | null {
  return buildSelect(store, onSwitch);
}
