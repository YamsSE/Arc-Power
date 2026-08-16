// Arc Power - OcErrorCode -> user-facing message mapping (pure, DOM-free).
// Each code gets a clear, actionable message for a per-control toast.

import type { OcErrorCode } from '../types.ts';

export const CONTROL_LABELS: Record<string, string> = {
  powerLimitW: 'Power limit',
  gpuVoltOffsetV: 'Voltage offset',
  // M4-B: the card is named 'Core clock' in BOTH Offset and Clock
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
  // M8 (the Graphics tab): the 3D-feature controls (the dedicated graphics
  // apply path's per-control toasts).
  frameGenOverride: 'XeSS FG override',
  flipMode: 'Frame sync',
  frameLimit: 'FPS limit',
  lowLatency: 'Low latency',
};

const ERROR_MESSAGES: Record<OcErrorCode, string> = {
  'waiver-not-set': 'The warranty waiver is not accepted for this GPU. Accept the waiver and apply again.',
  'out-of-range': 'The value is outside the range supported by this GPU - the slider clamps to the supported range.',
  // M22: reworded - there is NO in-session unlock on driver 8974 (a {0,0}
  // GpuLockSet write min-pins instead of unlocking and resetToDefaults does
  // not clear a held lock), so the old "Unlock it to apply changes" offered
  // an action that does not exist - the honest guidance is the reboot.
  'locked-mode': 'Overclocking is locked on this GPU (voltage locked mode). The GPU lock is held - reboot to clear it, then apply changes.',
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

/**
 * M17d (Run C, item 0b): the per-control apply-failure text - the toast
 * surface's ONE preference point. The app-side GATE refusals (ocModeRefusal
 * -> refusalPerControl in main) carry their OWN actionable message (the
 * mode/ceiling text - 'This value is above the maximum the GPU can accept.
 * Nothing was changed.' / the stock-mode text): that message ALWAYS wins.
 * The errorCode mapping (errors.ts ERROR_MESSAGES - e.g. the 'out-of-range'
 * 'slider clamps' text) is the FALLBACK for the DRIVER-shaped refusals (a
 * real driver out-of-range carries errorCode only, no message - the honest
 * mapped text answers). A refusal changes nothing - the 'clamps' lie must
 * never surface for a gate refusal; a driver out-of-range without a message
 * keeps the mapping.
 * @param {import('../types.ts').PerControlResult | null | undefined} per
 * @param {string} [control] the control label key (CONTROL_LABELS)
 * @returns {string}
 */
export function applyFailureText(per: import('../types.ts').PerControlResult | null | undefined, control?: string): string {
  if (typeof per?.message === 'string' && per.message.length > 0) return per.message;
  return errorMessage(per?.errorCode, control);
}
