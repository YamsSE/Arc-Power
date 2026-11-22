import type { DeviceInfo, VendorDeviceInfo } from '../types.ts';
import { amdComputeUnitsOf } from '../../shared/amd-static-info.ts';

/** Vendor telemetry belongs only to the inventory row whose local adapter id
 * was explicitly selected for the vendor-info request. Never paint the active
 * adapter's values onto another GPU's dashboard card. */
export function vendorInfoForDashboardDevice(
  device: Pick<DeviceInfo, 'id'>,
  selectedDeviceId: number | null | undefined,
  vendorInfo: VendorDeviceInfo | null | undefined,
): VendorDeviceInfo | null {
  return selectedDeviceId === device.id ? vendorInfo ?? null : null;
}

/** Resolve AMD compute units for one inventory row. A selected row may use
 * its matching vendor telemetry; every row can use only its own exact model
 * name as the published-spec fallback. */
export function amdComputeUnitsForDashboardDevice(
  device: Pick<DeviceInfo, 'id' | 'name' | 'gpuVendor' | 'osController'>,
  selectedDeviceId: number | null | undefined,
  vendorInfo: VendorDeviceInfo | null | undefined,
): number | null {
  const isAmd = device.gpuVendor === 'amd'
    || /VEN_1002/i.test(String(device.osController?.pnpDeviceId ?? ''))
    || /\b(?:amd|radeon)\b/i.test(device.name);
  if (!isAmd) return null;
  const selectedInfo = vendorInfoForDashboardDevice(device, selectedDeviceId, vendorInfo);
  const measured = selectedInfo?.computeUnits;
  if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) return measured;
  return amdComputeUnitsOf(device.name);
}
