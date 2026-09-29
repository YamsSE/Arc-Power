import type { Capabilities, DeviceState, Settings } from '../types.ts';
import { isBattlemageGpuName } from './hardware-icons.ts';

/**
 * Preserve profile VF coordinates and scalar offsets exactly for Battlemage.
 * The backend owns VF/offset dependency checks and must receive the complete
 * profile so it can either apply it safely or report the conflicting fields.
 */
export function normalizeBattlemageProfileSettings(
  settings: Settings,
  caps: Capabilities | null,
  currentState: DeviceState | null = null,
): Settings {
  const out = { ...settings };
  if (!isBattlemageGpuName(caps?.deviceName, caps) || !Array.isArray(out.vfCurve)) return out;

  // Keep the VF payload even when the renderer's capability snapshot says
  // the surface is unavailable. The backend must see the profile dependency
  // so it can refuse dependent core offsets instead of applying them alone.
  return out;
}
