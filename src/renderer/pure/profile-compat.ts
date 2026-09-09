import type { Capabilities, DeviceState, Settings } from '../types.ts';
import { isBattlemageGpuName } from './hardware-icons.ts';
import { isLegacyBakedB580VfCurve, isLegacyStockVfCurve } from './vf-curve.ts';

/**
 * Normalize the VF portion of a profile for a Battlemage target. Older
 * profiles can carry the same frequencies on a voltage grid from another
 * driver revision; that exact legacy fingerprint is omitted. Custom voltage
 * coordinates remain intact, while a custom curve owns the core voltage and
 * frequency shape instead of replaying stale scalar offsets beside it.
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
  const bakedB580 = Array.isArray(native) && isLegacyBakedB580VfCurve(out.vfCurve, native);
  if (Array.isArray(native)
    && (isLegacyStockVfCurve(out.vfCurve, native, out.gpuFreqOffsetMhz) || bakedB580)) {
    delete out.vfCurve;
    // Older B580 profiles persisted the translated table but lost the scalar
    // field that created it. Restore the equivalent scalar so loading keeps
    // the user's clock target instead of merely avoiding the custom-table
    // refusal.
    if (bakedB580 && !Number.isFinite(out.gpuFreqOffsetMhz)) out.gpuFreqOffsetMhz = 100;
  } else if (Array.isArray(out.vfCurve)) {
    // Battlemage's scalar voltage and frequency offsets target the same core
    // VF surface as a custom curve. Replaying either one before the table
    // makes the driver's custom write fail with a generic io-failed result.
    delete out.gpuVoltOffsetV;
    delete out.gpuFreqOffsetMhz;
  }
  return out;
}
