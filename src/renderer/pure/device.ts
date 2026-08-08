// Arc Power — M4-F pure device-selection helpers (no DOM): the boot
// selection preference, the selector visibility rule and the selector
// option list. The DOM `<select>` lives in components/device-select.ts; the
// switch flow lives in device.ts (createDeviceSwitcher). Unit-tested.

import type { DeviceInfo } from '../types.ts';

/**
 * M4-F boot selection: the persisted deviceId wins when it matches an
 * enumerated device id; otherwise devices[0] (the honest single-device
 * default). The MAIN-side boot resolution (resolveBootDeviceId) is the
 * authority and has already self-healed the persisted id before the
 * renderer's first device-get round trip — this is the renderer's mirror
 * of the same rule for the id the IPC returned. Null when nothing is
 * enumerated (the caller degrades — never a crash).
 */
export function resolveBootDevice(devices: DeviceInfo[], persistedId: number | null): number | null {
  if (devices.length === 0) return null;
  if (persistedId !== null && devices.some((d) => d.id === persistedId)) return persistedId;
  return devices[0].id;
}

/**
 * M4-F: the device selector renders ONLY with 2+ devices — the honest
 * single-device degradation (the live 1-GPU machine shows nothing new).
 */
export function showDeviceSelector(devices: DeviceInfo[]): boolean {
  return devices.length > 1;
}

/**
 * M4-F: the selector option list. Each option carries the device NAME
 * (the backend formats the VRAM suffix into device.name at enumeration
 * time — the option text never re-derives it); `selected` marks the
 * current device.
 */
export function deviceSelectorOptions(
  devices: DeviceInfo[],
  currentId: number | null,
): Array<{ id: number; label: string; selected: boolean }> {
  return devices.map((d) => ({ id: d.id, label: d.name, selected: d.id === currentId }));
}
