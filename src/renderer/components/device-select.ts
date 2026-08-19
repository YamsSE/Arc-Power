// Arc Power - compact GPU selectors. Dashboard exposes the all-device
// inspection control; Tuning gets an Arc-only selector only when two or more
// Arc adapters are present.

import { el } from '../dom.ts';
import type { Store } from '../router.ts';
import { showDeviceSelector, deviceSelectorOptions, showArcDeviceSelector, arcDeviceSelectorOptions } from '../pure/device.ts';

function buildSelect(store: Store, onSwitch: (id: number) => void, arcOnly: boolean): HTMLElement | null {
  const s = store.get();
  if (arcOnly ? !showArcDeviceSelector(s.devices, s.deviceId) : !showDeviceSelector(s.devices)) return null;
  const options = arcOnly ? arcDeviceSelectorOptions(s.devices, s.deviceId) : deviceSelectorOptions(s.devices, s.deviceId);
  return el('select', {
    class: 'device-select',
    title: arcOnly ? 'Select Arc GPU' : 'Inspect GPU',
    'aria-label': arcOnly ? 'Select Arc GPU' : 'Inspect GPU',
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
  return buildSelect(store, onSwitch, false);
}

export function buildArcDeviceSelect(store: Store, onSwitch: (id: number) => void): HTMLElement | null {
  return buildSelect(store, onSwitch, true);
}
