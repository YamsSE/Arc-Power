// Arc Power - M4-F pure device-selection helpers (no DOM): the boot
// selection preference, the selector visibility rule and the selector
// option list. The DOM `<select>` lives in components/device-select.ts; the
// switch flow lives in device.ts (createDeviceSwitcher). Unit-tested.

import type { DeviceInfo } from '../types.ts';

/**
 * Resolve a boot selection. With a durable key, identity wins; an explicit
 * null/absent key marks a legacy numeric-only setting as unverified.
 */
export function resolveBootDevice(devices: DeviceInfo[], persistedId: number | null, persistedKey?: string | null): number | null {
  if (devices.length === 0) return null;
  if (typeof persistedKey === 'string' && persistedKey.length > 0) {
    const matched = devices.find((d) => (d.deviceKey ?? deviceHardwareKey(d)) === persistedKey);
    if (matched) return matched.id;
  } else if (persistedKey === undefined && persistedId !== null && devices.some((d) => d.id === persistedId)) {
    return persistedId;
  }
  return devices[0].id;
}

/**
 * M4-F: the device selector renders ONLY with 2+ devices - the honest
 * single-device degradation (the live 1-GPU machine shows nothing new).
 */
export function showDeviceSelector(devices: DeviceInfo[]): boolean {
  return devices.length > 1;
}

/**
 * M4-F: the selector option list. Each option carries the device NAME
 * (the backend formats the VRAM suffix into device.name at enumeration
 * time - the option text never re-derives it); `selected` marks the
 * current device.
 */
export function deviceSelectorOptions(
  devices: DeviceInfo[],
  currentId: number | null,
): Array<{ id: number; label: string; selected: boolean }> {
  return devices.map((d) => ({ id: d.id, label: d.name, selected: d.id === currentId }));
}

/**
 * M4I (final-review F1): strip the VRAM suffix the backend formats into
 * device.name at enumeration ("Name 8GB GDDR6" / "Name 8GB") so a name
 * comparison (the dashboard's matchedController controller lookup) sees
 * the plain GPU name on BOTH sides. The M4H suffix (" 16 GB") was removed
 * by the M4I ceil+type format - without the strip the match falls back to
 * videoControllers[0] and the ReBAR pill can bind to the wrong GPU on
 * multi-GPU machines. Unit-tested.
 */
export function stripVramSuffix(name: string): string {
  return name.trim().replace(/\s+\d+\s*GB(\s+\S+)?$/i, '').trim();
}

/** Stable PCI/BDF identity mirror of the main-side deviceHardwareKey. */
export function deviceHardwareKey(device: Pick<DeviceInfo, 'pciVendorId' | 'pciDeviceId' | 'bdf'>): string {
  const vendor = String(device.pciVendorId ?? '').toLowerCase();
  const pci = String(device.pciDeviceId ?? '').toLowerCase();
  const bus = Number.isInteger(device.bdf?.bus) ? device.bdf.bus : -1;
  const slot = Number.isInteger(device.bdf?.device) ? device.bdf.device : -1;
  const fn = Number.isInteger(device.bdf?.function) ? device.bdf.function : -1;
  const hasBdf = bus !== 0 || slot !== 0 || fn !== 0;
  return `pci:${vendor}:${pci}@${hasBdf ? bus : -1}:${hasBdf ? slot : -1}.${hasBdf ? fn : -1}`;
}

export function isIntegratedStyleDevice(device: Pick<DeviceInfo, 'name'>): boolean {
  const name = String(device.name ?? '').replace(/\s+\d+\s*GB(?:\s+\S+)?$/i, '');
  if (/\b(?:iris|uhd|hd graphics|xe graphics)\b/i.test(name)) return true;
  return /\barc\b/i.test(name) && !/\b(?:a\d{3}|b\d{2,3}|pro)\b/i.test(name);
}

export function sortDevicesDiscreteFirst<T extends Pick<DeviceInfo, 'name' | 'pciVendorId' | 'pciDeviceId' | 'bdf'>>(devices: T[]): T[] {
  return devices.map((device, index) => ({ device, index })).sort((a, b) => {
    const classDiff = Number(isIntegratedStyleDevice(a.device)) - Number(isIntegratedStyleDevice(b.device));
    if (classDiff !== 0) return classDiff;
    const keyDiff = deviceHardwareKey(a.device).localeCompare(deviceHardwareKey(b.device));
    return keyDiff !== 0 ? keyDiff : a.index - b.index;
  }).map(({ device }) => device);
}

export function isArcDevice(device: Pick<DeviceInfo, 'name'>): boolean {
  const name = String(device.name ?? '');
  return /\barc\b/i.test(name)
    && !isIntegratedStyleDevice(device)
    && !/basic|microsoft/i.test(name);
}

export function showArcDeviceSelector(devices: DeviceInfo[], currentId: number | null = null): boolean {
  const arcDevices = devices.filter(isArcDevice);
  return arcDevices.length >= 2
    && (currentId === null || arcDevices.some((d) => d.id === currentId));
}

export function arcDeviceSelectorOptions(devices: DeviceInfo[], currentId: number | null): Array<{ id: number; label: string; selected: boolean }> {
  return devices.filter(isArcDevice).map((d) => ({ id: d.id, label: d.name, selected: d.id === currentId }));
}
