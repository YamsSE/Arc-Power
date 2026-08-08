// Arc Power - M4-F compact GPU selector (`<select>`, styled like the
// featureset dropdown). Rendered (a) on the Dashboard GPU card header row
// and (b) on the Tuning page top (the oc-mode row area); both drive the
// same selectDevice switch. Returns null when 1 device or fewer - the
// honest single-device degradation (the live 1-GPU machine shows nothing).

import { el } from '../dom.ts';
import type { Store } from '../router.ts';
import { showDeviceSelector, deviceSelectorOptions } from '../pure/device.ts';

/**
 * @param {Store} store the app store (devices + deviceId drive the options)
 * @param {(id: number) => void} onSwitch the selectDevice handler
 * @returns {HTMLElement | null} the `<select>`, or null with <= 1 device
 */
export function buildDeviceSelect(store: Store, onSwitch: (id: number) => void): HTMLElement | null {
  const s = store.get();
  if (!showDeviceSelector(s.devices)) return null;
  return el('select', {
    class: 'device-select',
    title: 'Select GPU',
    'aria-label': 'Select GPU',
    onchange: (e: Event) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (Number.isInteger(id)) onSwitch(id);
    },
  }, deviceSelectorOptions(s.devices, s.deviceId).map((o) => {
    const opt = el('option', { value: String(o.id), text: o.label });
    if (o.selected) opt.selected = true;
    return opt;
  }));
}
