import type { DeviceInfo, VideoControllerInfo } from '../types.ts';

function exactPnpIdentity(value: string | null | undefined): string | null {
  const identity = typeof value === 'string' ? value.trim() : '';
  return identity ? identity.toUpperCase() : null;
}

function hex4(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff) {
    return value.toString(16).padStart(4, '0');
  }
  if (typeof value !== 'string') return null;
  // The backend formats PCI ids as 32-bit zero-extended ("0x0000e20b"); the
  // significant 16 bits are the trailing four hex digits (same rule as the
  // main-process identity helpers).
  const trimmed = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(trimmed)) return null;
  return trimmed.slice(-4).padStart(4, '0');
}

/** Exact vendor:device pair - from the PNP id when present, otherwise from
 *  the explicit PCI ids the IGCL/native inventory rows carry. */
function pciPairIdentity(
  value: { pnpDeviceId?: string | null; pciVendorId?: unknown; pciDeviceId?: unknown } | null | undefined,
): string | null {
  const pnp = typeof value?.pnpDeviceId === 'string' ? value.pnpDeviceId : '';
  const vendor = pnp.match(/(?:^|[\\|&])VEN_([0-9A-F]{4})/i)?.[1] ?? hex4(value?.pciVendorId);
  const device = pnp.match(/(?:^|[\\|&])DEV_([0-9A-F]{4})/i)?.[1] ?? hex4(value?.pciDeviceId);
  return vendor && device ? `${vendor.toLowerCase()}:${device.toLowerCase()}` : null;
}

/** Exact PCI location. Accepts the inventory's bdf object and the CIM
 *  location string. A zeroed location is the "not supplied" shape, not a
 *  segment-zero device, so it never matches. */
function bdfIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    const bdf = text.match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (bdf) {
      const bus = Number.parseInt(bdf[2], 16);
      const device = Number.parseInt(bdf[3], 16);
      const fn = Number.parseInt(bdf[4], 10);
      return bus === 0 && device === 0 && fn === 0 ? null : `${bus}:${device}.${fn}`;
    }
    const location = text.match(/\bbus\s*(\d+)\s*,?\s*device\s*(\d+)\s*,?\s*function\s*(\d+)/i);
    if (!location) return null;
    const bus = Number(location[1]);
    const device = Number(location[2]);
    const fn = Number(location[3]);
    if (bus === 0 && device === 0 && fn === 0) return null;
    return `${bus}:${device}.${fn}`;
  }
  if (value && typeof value === 'object') {
    const raw = value as { bus?: unknown; device?: unknown; function?: unknown; func?: unknown };
    const bus = Number(raw.bus);
    const device = Number(raw.device);
    const fn = Number(raw.function ?? raw.func ?? 0);
    if (![bus, device, fn].every(Number.isInteger)) return null;
    if (bus < 0 || bus > 0xff || device < 0 || device > 0x1f || fn < 0 || fn > 7) return null;
    return bus === 0 && device === 0 && fn === 0 ? null : `${bus}:${device}.${fn}`;
  }
  return null;
}

/**
 * Apply a late sysinfo ReBAR verdict to the existing inventory when the
 * backend inventory refresh cannot carry it.
 *
 * Two exact identities are accepted, both requiring a UNIQUE row on each side:
 *  - PNP device id, when the inventory row already carries one (Electron's
 *    unified inventory);
 *  - PCI vendor:device pair plus the exact PCI location, for native host rows
 *    that have the IGCL pair/BDF but no Windows PNP id. A pair-only match is
 *    deliberately refused: two same-model adapters would otherwise be
 *    interchangeable.
 *
 * Only an explicit boolean driver/OS verdict is applied, and the row is only
 * rewritten when it differs - so an unknown stays unknown and no verdict is
 * ever inferred from the match itself.
 */
export function mergeRebarByStableIdentity(
  devices: DeviceInfo[],
  controllers: VideoControllerInfo[] | null | undefined,
): DeviceInfo[] {
  if (!controllers?.length || !devices.length) return devices;

  const controllerByPnp = new Map<string, VideoControllerInfo>();
  const duplicateControllers = new Set<string>();
  const controllerByLocation = new Map<string, VideoControllerInfo>();
  const duplicateControllerLocations = new Set<string>();
  for (const controller of controllers) {
    const pnp = exactPnpIdentity(controller.pnpDeviceId);
    if (pnp) {
      if (controllerByPnp.has(pnp)) duplicateControllers.add(pnp);
      else controllerByPnp.set(pnp, controller);
    }
    const pair = pciPairIdentity(controller);
    const bdf = bdfIdentity(controller.locationInfo);
    const key = pair && bdf ? `${pair}@${bdf}` : null;
    if (key) {
      if (controllerByLocation.has(key)) duplicateControllerLocations.add(key);
      else controllerByLocation.set(key, controller);
    }
  }

  const deviceByPnp = new Map<string, number>();
  const duplicateDevices = new Set<string>();
  const deviceByLocation = new Map<string, number>();
  const duplicateDeviceLocations = new Set<string>();
  devices.forEach((device, index) => {
    const pnp = exactPnpIdentity(device.osController?.pnpDeviceId);
    if (pnp) {
      if (deviceByPnp.has(pnp)) duplicateDevices.add(pnp);
      else deviceByPnp.set(pnp, index);
    }
    // Do NOT return after a PNP match. Native inventory rows and WMI rows can
    // carry different PNP instance suffixes for the same adapter; the BDF
    // location is the other half of the identity and must stay indexed too.
    // Both join loops below already refuse ambiguous duplicate keys.
    const pair = pciPairIdentity(device);
    const bdf = bdfIdentity(device.bdf);
    const key = pair && bdf ? `${pair}@${bdf}` : null;
    if (key) {
      if (deviceByLocation.has(key)) duplicateDeviceLocations.add(key);
      else deviceByLocation.set(key, index);
    }
  });

  let merged: DeviceInfo[] | null = null;
  const write = (index: number, osController: NonNullable<DeviceInfo['osController']>): void => {
    merged ??= devices.slice();
    merged[index] = { ...devices[index], osController };
  };

  for (const [pnp, index] of deviceByPnp) {
    if (duplicateDevices.has(pnp) || duplicateControllers.has(pnp)) continue;
    const controller = controllerByPnp.get(pnp);
    const device = devices[index];
    if (!controller || typeof controller.rebarActive !== 'boolean' || !device?.osController) continue;
    if (device.osController.rebarActive === controller.rebarActive) continue;
    write(index, { ...device.osController, rebarActive: controller.rebarActive });
  }

  for (const [key, index] of deviceByLocation) {
    if (duplicateDeviceLocations.has(key) || duplicateControllerLocations.has(key)) continue;
    const controller = controllerByLocation.get(key);
    const device = devices[index];
    if (!controller || typeof controller.rebarActive !== 'boolean' || !device) continue;
    if (device.osController) {
      if (device.osController.rebarActive === controller.rebarActive) continue;
      write(index, { ...device.osController, rebarActive: controller.rebarActive });
      continue;
    }
    write(index, {
      name: controller.name ?? device.name,
      vramBytes: controller.vramBytes ?? device.vramBytes ?? null,
      pnpDeviceId: controller.pnpDeviceId ?? null,
      sharedMemoryBytes: controller.sharedMemoryBytes ?? null,
      sharedMemorySource: controller.sharedMemorySource ?? null,
      driverVersion: controller.driverVersion ?? null,
      displayActive: controller.displayActive ?? null,
      rebarActive: controller.rebarActive,
    });
  }
  return merged ?? devices;
}
