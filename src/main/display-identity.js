// Arc Power - stable Display identity namespaces.

const DISPLAY_KEY_MARKER = '|display|';

/**
 * Return the driver/display portion of a stable display key, or null when the
 * key is not in the canonical adapter|display|output form.
 * @param {unknown} displayKey
 * @returns {string|null}
 */
export function displayKeySuffix(displayKey) {
  if (typeof displayKey !== 'string') return null;
  const marker = displayKey.indexOf(DISPLAY_KEY_MARKER);
  if (marker < 0) return null;
  const suffix = displayKey.slice(marker + DISPLAY_KEY_MARKER.length);
  return suffix.length > 0 ? suffix : null;
}

/**
 * Put a display key in the requested adapter namespace while preserving the
 * physical output identity. Malformed/non-canonical keys are preserved so a
 * row is never silently made to disappear during a degraded read-back.
 * @param {unknown} displayKey
 * @param {unknown} deviceKey
 * @returns {string|null}
 */
export function displayKeyInNamespace(displayKey, deviceKey) {
  if (typeof displayKey !== 'string') return displayKey ?? null;
  if (typeof deviceKey !== 'string' || deviceKey.length === 0) return displayKey;
  const suffix = displayKeySuffix(displayKey);
  return suffix === null ? displayKey : `${deviceKey}${DISPLAY_KEY_MARKER}${suffix}`;
}

/**
 * Canonicalize a Display read-back to the parent request's adapter namespace.
 * The worker may have rebuilt the inventory with a different durable adapter
 * key, but the renderer must be able to apply again using its original key.
 * @param {unknown} state
 * @param {string|null} canonicalDeviceKey
 * @returns {object|null|unknown}
 */
export function normalizeDisplayStateIdentity(state, canonicalDeviceKey) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return state;
  const deviceKey = typeof canonicalDeviceKey === 'string' && canonicalDeviceKey.length > 0
    ? canonicalDeviceKey
    : state.deviceKey ?? null;
  return {
    ...state,
    deviceKey,
    displays: Array.isArray(state.displays)
      ? state.displays.map((display) => {
        if (display === null || typeof display !== 'object' || Array.isArray(display)) return display;
        return { ...display, displayKey: displayKeyInNamespace(display.displayKey, deviceKey) };
      })
      : state.displays,
  };
}
