import type { Capabilities, DeviceState, Settings } from '../types.ts';
import { isBattlemageGpuName } from './hardware-icons.ts';
import { isLegacyStockVfCurve } from './vf-curve.ts';

/**
 * Normalize the VF portion of a profile for a Battlemage target. Older
 * profiles can carry the same frequencies on a voltage grid from another
 * driver revision; that exact legacy fingerprint is omitted. Custom voltage
 * coordinates remain intact, while a custom curve owns core frequency instead
 * of replaying a stale scalar offset beside it.
 */
export function normalizeBattlemageProfileSettings(
  settings: Settings,
  caps: Capabilities | null,
  currentState: DeviceState | null = null,
): Settings {
  const out = { ...settings };
  if (!isBattlemageGpuName(caps?.deviceName, caps) || !Array.isArray(out.vfCurve)) return out;

  const native = Array.isArray(currentState?.vfCurveDefault) && currentState.vfCurveDefault.length >= 2
    ? currentState.vfCurveDefault
    : currentState?.vfCurve;
  if (caps?.controls?.vfCurve !== true) {
    delete out.vfCurve;
    return out;
  }
  if (Array.isArray(native)
    && isLegacyStockVfCurve(out.vfCurve, native, out.gpuFreqOffsetMhz)) {
    delete out.vfCurve;
  } else if (Array.isArray(out.vfCurve)) {
    delete out.gpuFreqOffsetMhz;
  }
  return out;
}
