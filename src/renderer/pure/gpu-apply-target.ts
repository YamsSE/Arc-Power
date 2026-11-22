import type { DeviceInfo } from '../types.ts';

export interface ExpectedGpuApplyTarget {
  deviceKey: string;
  physicalTarget: {
    deviceKey: string;
    pciVendorId: string;
    pciDeviceId: string;
    bdf: { bus: number; device: number; function: number };
    luid?: string | null;
  };
}

/**
 * Attach the renderer's selected physical identity to an apply request. If a
 * row lacks a stable key or PCI address, leave the option absent. The Tauri
 * host rejects a direct apply without proof instead of guessing its target.
 */
export function gpuApplyTargetOptions(device: DeviceInfo | null | undefined): {
  expectedTarget?: ExpectedGpuApplyTarget;
} {
  const key = device?.deviceKey;
  const bdf = device?.bdf;
  if (!device || typeof key !== 'string' || !key
    || !/^0x[0-9a-f]{8}$/i.test(device.pciVendorId)
    || !/^0x[0-9a-f]{8}$/i.test(device.pciDeviceId)
    || !bdf || !Number.isInteger(bdf.bus) || !Number.isInteger(bdf.device) || !Number.isInteger(bdf.function)) {
    return {};
  }
  if (bdf.bus < 0 || bdf.bus > 255 || bdf.device < 0 || bdf.device > 31
    || bdf.function < 0 || bdf.function > 7 || (bdf.bus === 0 && bdf.device === 0 && bdf.function === 0)) {
    return {};
  }
  return {
    expectedTarget: {
      deviceKey: key,
      physicalTarget: {
        deviceKey: key,
        pciVendorId: device.pciVendorId,
        pciDeviceId: device.pciDeviceId,
        bdf: { bus: bdf.bus, device: bdf.device, function: bdf.function },
        ...(typeof device.luid === 'string' ? { luid: device.luid } : {}),
      },
    },
  };
}
