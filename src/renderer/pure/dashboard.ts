// M30: dashboard static data must follow the selected inventory record.

import type { DeviceInfo } from '../types.ts';
import { deviceHardwareKey } from './device.ts';

export interface DashboardController {
  name?: string | null;
  vramBytes?: number | null;
  pnpDeviceId?: string | null;
  driverVersion?: string | null;
  rebarActive?: boolean | null;
}

/** Put the adapter driving an explicitly active display first. The remaining
 * inventory keeps its existing order; stable PCI/device identity is used only
 * to break ties between multiple active display adapters. */
export function dashboardGpuOrder<T extends Pick<DeviceInfo, 'id' | 'name' | 'pciVendorId' | 'pciDeviceId' | 'bdf'> & { displayActive?: boolean | null; deviceKey?: string }>(devices: T[]): T[] {
  return devices
    .map((device, index) => ({ device, index }))
    .sort((left, right) => {
      const activeDiff = Number(right.device.displayActive === true) - Number(left.device.displayActive === true);
      if (activeDiff !== 0) return activeDiff;
      if (left.device.displayActive === true && right.device.displayActive === true) {
        const leftKey = left.device.deviceKey ?? deviceHardwareKey(left.device);
        const rightKey = right.device.deviceKey ?? deviceHardwareKey(right.device);
        const keyDiff = leftKey.localeCompare(rightKey);
        if (keyDiff !== 0) return keyDiff;
      }
      return left.index - right.index;
    })
    .map(({ device }) => device);
}

export function dashboardDeviceStatusLabel(index: number, gpuCount: number): string {
  return gpuCount > 1 ? `Device detected ${index + 1}` : 'Device detected';
}

export function selectedDashboardController(
  selectedController: DashboardController | null | undefined,
  noDeviceController: DashboardController | null | undefined,
  hasSelectedDevice: boolean,
): DashboardController | null {
  return (hasSelectedDevice ? selectedController : noDeviceController) ?? null;
}
