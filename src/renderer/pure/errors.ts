// Arc Power - OcErrorCode -> user-facing message mapping (pure, DOM-free).
// Each code gets a clear, actionable message for a per-control toast.

import type { OcErrorCode } from '../types.ts';

export const CONTROL_LABELS: Record<string, string> = {
  powerLimitW: 'Power limit',
  gpuVoltOffsetV: 'Voltage offset',
  // M4-B (user): the card is named 'Core clock' in BOTH Offset and Clock
  // toggle modes - the mode is the input presentation, not the name.
  gpuFreqOffsetMhz: 'Core clock',
  tempLimitC: 'Temperature limit',
  vramFreqOffsetGts: 'VRAM frequency offset',
  vramVoltOffsetV: 'VRAM voltage offset',
  gpuLock: 'GPU lock',
  vfCurve: 'Custom VF curve',
  fanMode: 'Fan mode',
  fanCurve: 'Fan curve',
  fixedFanPct: 'Fixed fan speed',
};

const ERROR_MESSAGES: Record<OcErrorCode, string> = {
  'waiver-not-set': 'The warranty waiver is not accepted for this GPU. Accept the waiver and apply again.',
  'out-of-range': 'The value is outside the range supported by this GPU - the slider clamps to the supported range.',
  'locked-mode': 'Overclocking is locked on this GPU (voltage locked mode). Unlock it to apply changes.',
  'reset-required': 'This GPU requires a reset before the value can be applied. Reset the device and apply again.',
  unsupported: 'This control is not supported on this GPU.',
  'unavailable-symbol': 'The IGCL runtime on this driver is missing the API for this control - update the Intel graphics driver.',
  'invalid-argument': 'The driver rejected the value as invalid - update the Intel graphics driver and try again.',
  'io-failed': 'The GPU driver did not accept the value (read-back mismatch).',
};

/**
 * Map an OcErrorCode to a user-facing message. When a control name is
 * provided the message is prefixed with the control label (used by the
 * per-control toasts).
 */
export function errorMessage(errorCode: OcErrorCode | undefined, control?: string): string {
  if (!errorCode) return '';
  const base = ERROR_MESSAGES[errorCode] ?? 'The apply failed.';
  return control ? `${CONTROL_LABELS[control] ?? control}: ${base}` : base;
}
