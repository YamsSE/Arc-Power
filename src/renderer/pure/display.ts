// Arc Power - pure helpers for the Graphics > Display view.
//
// These helpers deliberately only describe controls that have a verified
// driver contract. Capability rows that are not writable stay outside the
// payload and are rendered as read-only by the page.

import type { DisplaySettings, DisplayState } from '../types.ts';

export type Display = DisplayState['displays'][number];

/**
 * Resolve the selected display without letting an absent stable key collapse
 * every row onto the first display. Numeric ids are session-local, but remain
 * the correct fallback when the driver could not prove a display key.
 */
export function selectedDisplayOf(
  displays: ReadonlyArray<Display> | null | undefined,
  selectedDisplayKey: string | null | undefined,
  selectedDisplayId: number | null | undefined,
): Display | null {
  const rows = Array.isArray(displays) ? displays : [];
  const keyed = typeof selectedDisplayKey === 'string' && selectedDisplayKey.length > 0
    ? rows.find((display) => display.displayKey === selectedDisplayKey)
    : undefined;
  return keyed
    ?? rows.find((display) => display.id === selectedDisplayId)
    ?? rows[0]
    ?? null;
}

export const DISPLAY_QUANTIZATION_OPTIONS: NonNullable<DisplaySettings['quantizationRange']>[] = ['default', 'limited', 'full'];
export const DISPLAY_WIRE_FORMAT_OPTIONS: NonNullable<DisplaySettings['wireFormat']>['model'][] = ['RGB', 'YCbCr420', 'YCbCr422', 'YCbCr444'];
export const DISPLAY_BPC_OPTIONS = [6, 8, 10, 12];
export const DISPLAY_SCALING_MODE_OPTIONS: NonNullable<DisplaySettings['scalingMode']>[] = ['identity', 'centered', 'stretched', 'aspect-ratio-centered-max', 'custom'];
export const DISPLAY_RETRO_SCALING_METHOD_OPTIONS: NonNullable<DisplaySettings['scalingMethod']>['method'][] = ['integer', 'nearest-neighbour'];
export const DISPLAY_ARC_SYNC_PROFILE_OPTIONS: NonNullable<DisplaySettings['vrrMode']>[] = ['recommended', 'excellent', 'good', 'compatible', 'off', 'vesa', 'custom'];
export const DISPLAY_GLOBAL_VRR_MODE_OPTIONS: NonNullable<DisplaySettings['globalVrrMode']>[] = ['fullscreen', 'fullscreen-windowed', 'disabled'];
export const DISPLAY_GPU_SCALING_METHOD_OPTIONS: NonNullable<DisplaySettings['scalingMode']>[] = ['centered', 'stretched', 'aspect-ratio-centered-max'];
export const DISPLAY_DISPLAY_SCALING_METHOD_OPTIONS: NonNullable<DisplaySettings['displayScalingMethod']>[] = ['maintain-display-scaling', 'custom'];
export const DISPLAY_SCALING_METHOD_OPTIONS: string[] = [
  ...DISPLAY_DISPLAY_SCALING_METHOD_OPTIONS,
  ...DISPLAY_GPU_SCALING_METHOD_OPTIONS,
  ...DISPLAY_RETRO_SCALING_METHOD_OPTIONS,
];
export const DISPLAY_COLOR_CONTROLS = ['hue', 'saturation', 'brightness', 'contrast'] as const;

export type DisplayScalingView = 'gpu-scaling' | 'display-scaling' | 'retro-scaling';

function isGpuScalingMode(value: unknown): value is NonNullable<DisplaySettings['scalingMode']> {
  return DISPLAY_GPU_SCALING_METHOD_OPTIONS.includes(value as NonNullable<DisplaySettings['scalingMode']>);
}

function isExplicitScalingPreference(value: unknown): value is 'gpu-scaling' | 'display-scaling' {
  return value === 'gpu-scaling' || value === 'display-scaling';
}

/** Resolve raw mode for payload construction without changing native readback.
 * Active Custom wins over stale GPU preference; Arc selection is trusted only
 * when the backend marks it as validated for this display. */
export function effectiveScalingModeOf(display: Display | null | undefined): string | null {
  if (!display) return null;
  const active = display.scalingMode;
  const preferred = display.preferredScalingMode;
  if (active === 'custom') return 'custom';
  if (display.scalingPreferenceSource === 'arc-selection' && display.scalingPreference === 'display-scaling') return 'identity';
  if (preferred === 'custom') return 'custom';
  if (isGpuScalingMode(preferred)) return preferred;
  if (active !== null && active !== undefined) return active;
  return preferred ?? null;
}

export function scalingViewOf(display: Display | null | undefined): DisplayScalingView {
  if (!display) return 'display-scaling';
  const retro = display.scalingMethod?.value;
  if (retro?.enabled === true) return 'retro-scaling';
  // The selectors describe the user's persisted choice. Keep the active raw
  // IGCL read-back separate: a GPU preference can be saved while Identity is
  // active because the current desktop resolution does not require resizing.
  if (display.scalingMode === 'custom') return 'display-scaling';
  if (display.scalingPreferenceSource === 'arc-selection'
    && isExplicitScalingPreference(display.scalingPreference)) return display.scalingPreference;
  const raw = effectiveScalingModeOf(display);
  if (raw === 'custom') return 'display-scaling';
  if (isGpuScalingMode(raw)) return 'gpu-scaling';
  if (raw === 'identity') return 'display-scaling';
  return raw && raw !== 'identity' && raw !== 'custom'
    ? 'gpu-scaling'
    : 'display-scaling';
}

/** Return only the Scaling Method choices belonging to the selected IGS
 * Scaling Mode. The driver capability lists still narrow the raw methods so
 * we never render an option this adapter cannot prove. */
export function scalingMethodOptionsForView(display: Display | null | undefined, view: string): string[] {
  if (view === 'gpu-scaling') {
    const supported = display?.supportedOptions.scalingModes ?? [];
    return DISPLAY_GPU_SCALING_METHOD_OPTIONS.filter((mode) => supported.includes(mode));
  }
  if (view === 'retro-scaling') {
    const supported = display?.supportedOptions.scalingMethods ?? [];
    const retro = display?.scalingMethod?.value;
    if (display?.scalingMethod?.controllable !== true || !retro) return [];
    // A known disabled/null GET plus explicit capabilities allows choices;
    // an enabled but unknown native method must remain read-only.
    if (retro?.enabled === true && (!retro.method || !supported.includes(retro.method))) return [];
    return DISPLAY_RETRO_SCALING_METHOD_OPTIONS.filter((method) => supported.includes(method));
  }
  const supported = display?.supportedOptions.scalingModes ?? [];
  return DISPLAY_DISPLAY_SCALING_METHOD_OPTIONS.filter((method) => supported.includes(method === 'custom' ? 'custom' : 'identity'));
}

/** Only offer IGS scaling modes that have a matching driver capability and a
 * complete readback contract for the distinct Retro surface. */
export function scalingModeViewOptionsForDisplay(display: Display | null | undefined): DisplayScalingView[] {
  const retro = display?.scalingMethod?.value;
  if (retro?.enabled === true && (!retro.method || !display?.supportedOptions.scalingMethods.includes(retro.method))) return [];
  const supported = display?.supportedOptions.scalingModes ?? [];
  const options: DisplayScalingView[] = [];
  if (DISPLAY_GPU_SCALING_METHOD_OPTIONS.some((mode) => supported.includes(mode))) options.push('gpu-scaling');
  if (supported.includes('identity') || supported.includes('custom')) options.push('display-scaling');
  if (supported.includes('identity') && scalingMethodOptionsForView(display, 'retro-scaling').length > 0) options.push('retro-scaling');
  return options;
}

/** Windows modes exposed by the existing source-resolution capability. The
 * UI intentionally excludes generated presets and modes that have not yet
 * been enumerated by Windows. */
export function superResolutionSourceModesForDisplay(display: Display | null | undefined) {
  const capability = display?.superResolution;
  const native = capability?.nativeResolution;
  if (!display || display.identityVerified !== true || !display.displayKey
    || capability?.supported !== true || capability.controllable !== true || !native
    || !Number.isFinite(native.width) || native.width <= 0 || !Number.isFinite(native.height) || native.height <= 0
    || !capability.currentSourceResolution || !Number.isFinite(capability.currentSourceRefreshRate)
    || (capability.currentSourceRefreshRate ?? 0) <= 0 || !Array.isArray(capability.modes)) return [];
  return capability.modes.filter((mode) => Number.isFinite(mode.width) && mode.width > 0
    && Number.isFinite(mode.height) && mode.height > 0
    && Number.isFinite(mode.refreshRate) && mode.refreshRate > 0
    && mode.width > native.width && mode.height > native.height);
}

export function scalingMethodViewOf(display: Display | null | undefined): string {
  const view = scalingViewOf(display);
  if (view === 'retro-scaling') {
    const method = display?.scalingMethod?.value?.method;
    const options = scalingMethodOptionsForView(display, view);
    return method && options.includes(method) ? method : '';
  }
  const raw = effectiveScalingModeOf(display);
  if (view === 'gpu-scaling') {
    const options = scalingMethodOptionsForView(display, view);
    // The active mode remains authoritative for ordinary read-back. When it
    // is Identity, retain a supported saved GPU method for the deferred
    // preference; an unsupported preference falls through to the existing
    // capability-ordered default.
    const preferred = isGpuScalingMode(display?.preferredScalingMode)
      ? display.preferredScalingMode
      : raw;
    return preferred && options.includes(preferred) ? preferred : options[0] ?? '';
  }
  const options = scalingMethodOptionsForView(display, view);
  const preferred = raw === 'custom' ? 'custom' : 'maintain-display-scaling';
  return options.includes(preferred) ? preferred : options[0] ?? '';
}

/**
 * Translate the compact IGS three-way Scaling Mode view to the raw IGCL
 * scaling flag. Custom is intentionally owned by the separate Scaling Method
 * control; selecting ordinary GPU Scaling must never silently submit Custom.
 * When an existing non-custom GPU flag is active, preserve it. Otherwise use
 * the IGS stretch flag as the generic GPU-scaling default.
 */
export function rawScalingForView(display: Display, view: string): NonNullable<DisplaySettings['scalingMode']> {
  const supported = display.supportedOptions.scalingModes;
  if (view === 'display-scaling') return supported.includes('identity') ? 'identity' : (supported[0] as NonNullable<DisplaySettings['scalingMode']>);
  if (view === 'retro-scaling') {
    // Retro scaling is an adapter-level surface. Keep the ordinary output
    // scaler at IGS's neutral Display Scaling identity while Retro is active;
    // do not carry a prior Custom/GPU flag into the coupled write.
    return supported.includes('identity') ? 'identity' : (supported[0] as NonNullable<DisplaySettings['scalingMode']>);
  }
  const currentGpuMode = ['centered', 'stretched', 'aspect-ratio-centered-max']
    .find((mode) => effectiveScalingModeOf(display) === mode && supported.includes(mode as NonNullable<DisplaySettings['scalingMode']>));
  const gpuMode = currentGpuMode
    ?? ['stretched', 'aspect-ratio-centered-max', 'centered'].find((mode) => supported.includes(mode as NonNullable<DisplaySettings['scalingMode']>));
  return (gpuMode ?? supported[0]) as NonNullable<DisplaySettings['scalingMode']>;
}

/** Editor value for Custom scaling. Only read native percentages when Custom
 * is currently active; otherwise preserve the saved editor value or use IGS's
 * 100/100 default, never inactive zero-valued IGCL fields. */
export function customScalingPreferenceOf(display: Display | null | undefined): { x: number; y: number } {
  const details = display?.scalingMode === 'custom' ? display.scalingDetails : null;
  const saved = display?.customScalingPreference;
  const finitePair = (value: { x?: number; y?: number } | null | undefined): value is { x: number; y: number } =>
    Number.isFinite(value?.x) && Number.isFinite(value?.y);
  const active = Number.isFinite(details?.customX) && Number.isFinite(details?.customY)
    ? { x: details!.customX, y: details!.customY }
    : null;
  const selected = finitePair(active)
    ? active
    : finitePair(saved) ? saved : { x: 100, y: 100 };
  return {
    x: Math.max(0, Math.min(100, selected.x)),
    y: Math.max(0, Math.min(100, selected.y)),
  };
}

/** A safe Retro disable pair exists only when GET confirmed both an enabled
 * state and its current supported method. False/null needs no redundant SET. */
export function retroScalingDisableSettingsOf(display: Display | null | undefined): NonNullable<DisplaySettings['scalingMethod']> | null {
  const current = display?.scalingMethod?.value;
  if (current?.enabled !== true || !current.method
    || !(display?.supportedOptions.scalingMethods ?? []).includes(current.method)) return null;
  return { enabled: false, method: current.method };
}

export type DisplayColorRange = { min: number; max: number; step: number; default?: number };

/** Clamp a native IGCL color value to the exact step reported by the driver. */
export function snapDisplayColorValue(value: number, range: DisplayColorRange): number {
  const min = Number.isFinite(range.min) ? range.min : 0;
  const max = Number.isFinite(range.max) && range.max >= min ? range.max : min;
  const step = Number.isFinite(range.step) && range.step > 0 ? range.step : 1;
  const fallback = Number.isFinite(range.default) ? Number(range.default) : min;
  const numeric = Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(min, Math.min(max, numeric));
  const snapped = min + Math.round((clamped - min) / step) * step;
  // Avoid exposing binary floating-point tails in the IPC payload/read-back
  // comparison (for example 1.2 + 0.01 becoming 1.2099999999999997).
  const rounded = Number(snapped.toFixed(12));
  return Math.max(min, Math.min(max, rounded));
}

export function isDisplayControlSupported(display: Display | null | undefined, control: string): boolean {
  if (!display || display.identityVerified !== true || typeof display.displayKey !== 'string' || display.displayKey.length === 0) return false;
  switch (control) {
    case 'quantizationRange': return display.supportedOptions.quantizationRanges.length > 0;
    case 'scalingMode': return scalingModeViewOptionsForDisplay(display).length > 0;
    case 'displayScalingMethod': return scalingMethodOptionsForView(display, 'display-scaling').length > 0;
    case 'scalingMethod': return scalingMethodOptionsForView(display, 'retro-scaling').length > 0;
    case 'vrrMode': return display.vrrMode?.controllable === true && (display.supportedOptions.vrrModes ?? []).length > 0;
    // Keep the IGS choices visible even when the driver refuses a read-back.
    // The apply path still reports the native refusal; hiding the control here
    // made a transient read-back failure look like the feature disappeared.
    case 'globalVrrMode': return display.globalVrrMode?.supported === true && (display.supportedOptions.globalVrrModes ?? []).length > 0;
    case 'variableRefreshRate': return display.variableRefreshRate?.controllable === true && display.variableRefreshRate.supported === true;
    case 'scalingCustom': return display.supportedOptions.scalingModes.includes('custom');
    case 'wireFormat': return DISPLAY_WIRE_FORMAT_OPTIONS.includes(display.colorFormat as NonNullable<DisplaySettings['wireFormat']>['model'])
      && display.supportedOptions.wireFormats.includes(display.colorFormat ?? '')
      && DISPLAY_BPC_OPTIONS.includes(display.colorDepth ?? 0)
      && display.supportedOptions.bpcDepths.includes(display.colorDepth ?? 0);
    case 'hue': return isDisplayColorWritable(display, 'hue');
    case 'saturation': return isDisplayColorWritable(display, 'saturation');
    case 'brightness': return isDisplayColorWritable(display, 'brightness');
    case 'contrast': return isDisplayColorWritable(display, 'contrast');
    case 'superResolution': {
      const capability = display.superResolution;
      const modes = superResolutionSourceModesForDisplay(display);
      const current = capability?.currentSourceResolution;
      return modes.length > 0 && (capability?.enabled !== true || modes.some((mode) => mode.width === current?.width
        && mode.height === current?.height && mode.refreshRate === capability.currentSourceRefreshRate));
    }
    default: return false;
  }
}

function isDisplayColorWritable(display: Display, key: typeof DISPLAY_COLOR_CONTROLS[number]): boolean {
  const capability = display[key];
  const range = display.supportedOptions.colorRanges?.[key];
  const value = capability?.source === 'igcl-managed-color' ? capability.desiredValue : capability?.value;
  return capability?.supported === true && capability.controllable === true
    && typeof value === 'number' && Number.isFinite(value)
    && !!range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min
    && Number.isFinite(range.step) && range.step > 0 && value >= range.min && value <= range.max;
}

export function displayDriverValue(display: Display | null | undefined, control: string): unknown {
  if (!display) return null;
  switch (control) {
    case 'quantizationRange': return display.quantizationRange;
    case 'scalingMode': return display.scalingMode;
    case 'displayScalingMethod': return scalingMethodViewOf(display);
    case 'scalingMethod': return display.scalingMethod?.value;
    case 'vrrMode': return display.vrrMode?.value;
    case 'globalVrrMode': return display.globalVrrMode?.value;
    case 'variableRefreshRate': return display.variableRefreshRate?.value;
    case 'scalingCustom': return display.scalingDetails ? {
      x: display.scalingDetails.customX,
      y: display.scalingDetails.customY,
      hardwareModeSet: display.scalingDetails.hardwareModeSet,
    } : null;
    case 'wireFormat': {
      if (display.colorFormat === null || display.colorDepth === null) return null;
      return { model: display.colorFormat, depth: display.colorDepth };
    }
    case 'hue': return display.hue?.value;
    case 'saturation': return display.saturation?.value;
    case 'brightness': return display.brightness?.value;
    case 'contrast': return display.contrast?.value;
    case 'superResolution': {
      const capability = display.superResolution;
      if (!capability) return null;
      const source = capability.currentSourceResolution;
      return capability.enabled === true && source && capability.currentSourceRefreshRate && capability.currentSourceRefreshRate > 0
        ? { enabled: true, width: source.width, height: source.height, refreshRate: capability.currentSourceRefreshRate }
        : { enabled: false };
    }
    default: return null;
  }
}

/** Value used to seed the user's editor. Managed Arc Power intent is kept
 * separate from `displayDriverValue`, which remains native/live-only. */
export function displaySettingValue(display: Display | null | undefined, control: string): unknown {
  if (!display) return null;
  if (DISPLAY_COLOR_CONTROLS.includes(control as typeof DISPLAY_COLOR_CONTROLS[number])) {
    const capability = display[control as typeof DISPLAY_COLOR_CONTROLS[number]];
    if (capability?.source === 'igcl-managed-color'
      && typeof capability.desiredValue === 'number' && Number.isFinite(capability.desiredValue)) {
      return capability.desiredValue;
    }
  }
  return displayDriverValue(display, control);
}

export function normalizeDisplaySettings(display: Display | null | undefined): DisplaySettings {
  const out: DisplaySettings = {};
  if (!display) return out;
  if (display.superResolution) {
    const capability = display.superResolution;
    const source = capability.currentSourceResolution;
    const modes = [...capability.modes, ...capability.presets];
    const current = source && capability.currentSourceRefreshRate
      ? modes.find((mode) => mode.width === source.width && mode.height === source.height && mode.refreshRate === capability.currentSourceRefreshRate)
      : undefined;
    out.superResolution = capability.enabled === true && current
      ? { enabled: true, width: current.width, height: current.height, refreshRate: current.refreshRate }
      : { enabled: false };
  }
  if (isDisplayControlSupported(display, 'quantizationRange')) {
    out.quantizationRange = display.quantizationRange ?? display.supportedOptions.quantizationRanges[0] as DisplaySettings['quantizationRange'];
  }
  if (isDisplayControlSupported(display, 'scalingMode')) {
    out.scalingMode = (display.scalingMode ?? display.supportedOptions.scalingModes[0]) as DisplaySettings['scalingMode'];
  }
  if (isDisplayControlSupported(display, 'displayScalingMethod')) {
    out.displayScalingMethod = scalingMethodViewOf(display) as DisplaySettings['displayScalingMethod'];
  }
  if (isDisplayControlSupported(display, 'scalingMethod') && display.scalingMethod?.value?.method) {
    out.scalingMethod = {
      enabled: display.scalingMethod.value.enabled,
      method: display.scalingMethod.value.method,
    };
  }
  if (isDisplayControlSupported(display, 'vrrMode') && display.vrrMode?.value) {
    out.vrrMode = display.vrrMode.value;
  }
  if (isDisplayControlSupported(display, 'globalVrrMode')) {
    out.globalVrrMode = (display.globalVrrMode?.value
      ?? display.supportedOptions.globalVrrModes?.[0]) as DisplaySettings['globalVrrMode'];
  }
  if (isDisplayControlSupported(display, 'variableRefreshRate') && display.variableRefreshRate?.value !== null && display.variableRefreshRate?.value !== undefined) {
    out.variableRefreshRate = display.variableRefreshRate.value;
  }
  if (isDisplayControlSupported(display, 'wireFormat')) {
    out.wireFormat = {
      model: (display.colorFormat ?? display.supportedOptions.wireFormats[0]) as NonNullable<DisplaySettings['wireFormat']>['model'],
      depth: display.colorDepth ?? display.supportedOptions.bpcDepths[0],
    };
  }
  for (const key of DISPLAY_COLOR_CONTROLS) {
    if (!isDisplayControlSupported(display, key)) continue;
    const value = displaySettingValue(display, key);
    if (typeof value === 'number' && Number.isFinite(value)) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

const QUANTIZATION_SET = new Set<unknown>(DISPLAY_QUANTIZATION_OPTIONS);
const WIRE_FORMAT_SET = new Set<unknown>(DISPLAY_WIRE_FORMAT_OPTIONS);
const SCALING_MODE_SET = new Set<unknown>(DISPLAY_SCALING_MODE_OPTIONS);
const RETRO_SCALING_METHOD_SET = new Set<unknown>(DISPLAY_RETRO_SCALING_METHOD_OPTIONS);
const ARC_SYNC_PROFILE_SET = new Set<unknown>(DISPLAY_ARC_SYNC_PROFILE_OPTIONS);
const GLOBAL_VRR_MODE_SET = new Set<unknown>(DISPLAY_GLOBAL_VRR_MODE_OPTIONS);
const SCALING_METHOD_SET = new Set<unknown>(DISPLAY_SCALING_METHOD_OPTIONS);

function isPositiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isListedSuperResolutionMode(value: { width?: unknown; height?: unknown; refreshRate?: unknown }, display?: Display | null): boolean {
  if (!display || !isPositiveDimension(value.width) || !isPositiveDimension(value.height) || !isPositiveDimension(value.refreshRate)) return false;
  return [...display.superResolution?.modes ?? [], ...display.superResolution?.presets ?? []]
    .some((mode) => mode.width === value.width && mode.height === value.height && mode.refreshRate === value.refreshRate);
}

export function validateSuperResolutionSettings(value: unknown, display?: Display | null): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const setting = value as { enabled?: unknown; width?: unknown; height?: unknown; refreshRate?: unknown };
  if (typeof setting.enabled !== 'boolean') return false;
  if (setting.width !== undefined && !isPositiveDimension(setting.width)) return false;
  if (setting.height !== undefined && !isPositiveDimension(setting.height)) return false;
  if (setting.refreshRate !== undefined && !isPositiveDimension(setting.refreshRate)) return false;
  return setting.enabled === false || isListedSuperResolutionMode(setting, display);
}

export function validateDisplaySettings(value: unknown, display?: Display | null): value is DisplaySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, v] of Object.entries(value)) {
    if (key === 'replaceExistingColorSettings') {
      if (typeof v !== 'boolean') return false;
    } else if (key === 'quantizationRange') {
      if (!QUANTIZATION_SET.has(v)) return false;
    } else if (key === 'scalingMode') {
      if (!SCALING_MODE_SET.has(v)) return false;
    } else if (key === 'displayScalingMethod') {
      if (!SCALING_METHOD_SET.has(v)) return false;
    } else if (key === 'scalingMethod') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const sm = v as { enabled?: unknown; method?: unknown };
      if (typeof sm.enabled !== 'boolean' || !RETRO_SCALING_METHOD_SET.has(sm.method)) return false;
    } else if (key === 'vrrMode') {
      if (!ARC_SYNC_PROFILE_SET.has(v)) return false;
    } else if (key === 'globalVrrMode') {
      if (!GLOBAL_VRR_MODE_SET.has(v)) return false;
    } else if (key === 'variableRefreshRate') {
      if (typeof v !== 'boolean') return false;
    } else if (key === 'scalingCustom') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const custom = v as { x?: unknown; y?: unknown; hardwareModeSet?: unknown };
      if (typeof custom.x !== 'number' || !Number.isFinite(custom.x) || custom.x < 0 || custom.x > 100
        || typeof custom.y !== 'number' || !Number.isFinite(custom.y) || custom.y < 0 || custom.y > 100
        || (custom.hardwareModeSet !== undefined && typeof custom.hardwareModeSet !== 'boolean')) return false;
    } else if (key === 'wireFormat') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const wf = v as { model?: unknown; depth?: unknown };
      if (!WIRE_FORMAT_SET.has(wf.model) || typeof wf.depth !== 'number' || !Number.isFinite(wf.depth) || !DISPLAY_BPC_OPTIONS.includes(wf.depth)) return false;
    } else if (key === 'superResolution') {
      if (!validateSuperResolutionSettings(v, display)) return false;
    } else if (DISPLAY_COLOR_CONTROLS.includes(key as typeof DISPLAY_COLOR_CONTROLS[number])) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function sameWireFormat(a: { model: string; depth: number } | null | undefined, b: { model: string; depth: number } | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.model === b.model && a.depth === b.depth;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function sameSuperResolutionIntent(a: unknown, b: unknown): boolean {
  if (a && typeof a === 'object' && (a as { enabled?: unknown }).enabled === false) {
    return Boolean(b && typeof b === 'object' && (b as { enabled?: unknown }).enabled === false);
  }
  return sameValue(a, b);
}

export function isDisplayControlDirty(control: string, draft: DisplaySettings, display: Display | null): boolean {
  if (!(control in draft) || !display || !isDisplayControlSupported(display, control)) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  const driver = DISPLAY_COLOR_CONTROLS.includes(control as typeof DISPLAY_COLOR_CONTROLS[number])
    ? displaySettingValue(display, control)
    : displayDriverValue(display, control);
  if (control === 'superResolution' && !validateSuperResolutionSettings(wanted, display)) return false;
  if (driver === null || driver === undefined) return true;
  if (control === 'superResolution') return !sameSuperResolutionIntent(wanted, driver);
  if (typeof wanted === 'string') return wanted !== driver;
  if (control === 'wireFormat') return !sameWireFormat(wanted as { model: string; depth: number }, driver as { model: string; depth: number });
  return !sameValue(wanted, driver);
}

export function isDisplayControlDirtyVsApplied(control: string, draft: DisplaySettings, display: Display | null, applied: DisplaySettings): boolean {
  if (!(control in draft) || (display && !isDisplayControlSupported(display, control))) return false;
  const wanted = (draft as Record<string, unknown>)[control];
  if (control === 'superResolution' && !validateSuperResolutionSettings(wanted, display)) return false;
  if (control in applied) {
    const appliedValue = (applied as Record<string, unknown>)[control];
    if (typeof wanted === 'string') return wanted !== appliedValue;
    if (control === 'superResolution') return !sameSuperResolutionIntent(wanted, appliedValue);
    if (control === 'wireFormat') return !sameWireFormat(wanted as { model: string; depth: number }, appliedValue as { model: string; depth: number });
    return !sameValue(wanted, appliedValue);
  }
  return isDisplayControlDirty(control, draft, display);
}

export function buildDisplaySettings(draft: DisplaySettings, display: Display | null, applied: DisplaySettings): DisplaySettings {
  const out: DisplaySettings = {};
  for (const key of Object.keys(draft) as (keyof DisplaySettings)[]) {
    if (key === 'replaceExistingColorSettings') continue;
    if (display && !isDisplayControlSupported(display, key)) continue;
    if (isDisplayControlDirtyVsApplied(key, draft, display, applied)) {
      let value = (draft as Record<string, unknown>)[key];
      if (display && DISPLAY_COLOR_CONTROLS.includes(key as typeof DISPLAY_COLOR_CONTROLS[number])) {
        const range = display.supportedOptions.colorRanges?.[key];
        if (range && typeof value === 'number') value = snapDisplayColorValue(value, range);
      }
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
