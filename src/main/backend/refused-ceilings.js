// Arc Power - M17c the session refused-ceiling store (pure-ish, unit-testable
// without hardware; unit-tested in test/refused-ceilings.test.js).
//
// When the driver refuses an apply (0x44000002/04/05/0d - the 'out-of-range'
// class), the app must never offer the refused value again IN THIS SESSION:
// the store snaps the exposed ceiling DOWN one step from the refused value
// (monotone - only ever lowered, never raised), and the getCapabilities
// merge applies the degraded maxes so the slider/caps never re-expose a
// value the driver refused.
//
// The store lives in the PARENT-side backend (a module-level Map<deviceId,
// Map<control, ceiling>>): the renderer's caps come from the parent process
// backend, and in the packaged app the real apply path is the short-lived
// elevated self-worker whose module state evaporates - so the PARENT records
// from the WORKER's result envelope (the refusal map at
// backend.interface.js:257-274: { control: { ok:false, errorCode:'out-of-range',
// ... }, ... }) + the attempted settings payload it sent. The IN-PROCESS
// apply path feeds the SAME recording helper (the always-elevated packaged
// EXE applies in-process via needsWorker()=false) - the perControl result +
// the attempted settings record into the same Map (pinned so the store is
// NOT dead code in the shipped product).
//
// Run B wires the store into getCapabilities (the merge AFTER the cache
// read, covering BOTH the cache-hit and cold paths) + the apply paths. This
// module ships the recording + merge primitives and their unit tests only.

/** A store: Map<deviceId, Map<control, number>> where the number is the
 *  DEGRADED ceiling (the exposed max) of that control for that device. */
export function createRefusedCeilingStore() {
  return new Map();
}

function deviceMapOf(store, deviceId, create) {
  if (!(store instanceof Map)) return null;
  let deviceMap = store.get(deviceId);
  if (!(deviceMap instanceof Map)) {
    if (!create) return null;
    deviceMap = new Map();
    store.set(deviceId, deviceMap);
  }
  return deviceMap;
}

/**
 * Record a native capability ceiling directly. This is used when a runtime
 * returns a capability-refusal error whose known ceiling is not derivable
 * from the attempted value and the normal one-step snap.
 */
export function recordCapabilityCeiling(store, deviceId, control, ceiling, range) {
  if (typeof control !== 'string' || control.length === 0) return;
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling)) return;
  if (!range || typeof range !== 'object') return;
  const min = range.min;
  const max = range.max;
  const step = range.step;
  if (typeof min !== 'number' || !Number.isFinite(min)
    || typeof max !== 'number' || !Number.isFinite(max)
    || typeof step !== 'number' || !Number.isFinite(step) || step <= 0
    || max < min || ceiling < min || ceiling > max) return;
  const gridIndex = (ceiling - min) / step;
  const nearestGridIndex = Math.round(gridIndex);
  const tolerance = Number.EPSILON * 256 * Math.max(1, Math.abs(gridIndex), Math.abs(nearestGridIndex));
  if (!Number.isFinite(gridIndex) || Math.abs(gridIndex - nearestGridIndex) > tolerance) return;
  const deviceMap = deviceMapOf(store, deviceId, true);
  if (!deviceMap) return;
  const existing = deviceMap.get(control);
  if (existing !== undefined && existing <= ceiling) return;
  deviceMap.set(control, ceiling);
}

/**
 * M17c: the core recording - snap the exposed ceiling DOWN one step from
 * the refused value (refusedValue - range.step), clamped to the range floor.
 * MONOTONE: only ever lowered - a higher (or equal) ceiling than the
 * recorded one never raises the record. Garbage inputs (non-finite values,
 * no positive step, a ceiling below the range floor) are no-ops - the store
 * never records an invented degrade.
 * @param {Map} store the session store (createRefusedCeilingStore)
 * @param {number|string} deviceId the device id
 * @param {string} control the canonical control name (e.g. 'powerLimitW')
 * @param {unknown} refusedValue the value the driver refused
 * @param {{ min?: unknown, step?: unknown }} range the control's capability
 *   range (the step is the snap quantum; the min the floor)
 */
export function recordRefusal(store, deviceId, control, refusedValue, range) {
  if (typeof refusedValue !== 'number' || !Number.isFinite(refusedValue)) return;
  if (!range || typeof range !== 'object') return;
  const step = range.step;
  const min = range.min;
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return;
  if (typeof min !== 'number' || !Number.isFinite(min)) return;
  const ceiling = refusedValue - step;
  if (!Number.isFinite(ceiling) || ceiling < min) return; // nothing to degrade below the floor
  // Float-drift guard: 0.235 - 0.001 = 0.23399999999999998 - round the
  // ceiling to the 9th decimal (beyond the canonical-unit precision).
  const snapped = Math.round(ceiling * 1e9) / 1e9;
  const deviceMap = deviceMapOf(store, deviceId, true);
  if (!deviceMap) return;
  const existing = deviceMap.get(control);
  if (existing !== undefined && existing <= snapped) return;
  deviceMap.set(control, snapped);
}

/**
 * M17c: the SHARED recording helper - walk a per-control result map (the
 * refusal map shape from the apply envelope, { control: { ok, errorCode,
 * ... } }) and record an 'out-of-range' refusal for every control whose
 * attempted value rides the settings payload. BOTH feeding paths use it:
 * (a) the WORKER-SHAPED result envelope (the parent-merge - the envelope
 * carries { ok, perControl, state, ... } + the settings the parent sent);
 * (b) the IN-PROCESS perControl result + the attempted settings (the
 * always-elevated packaged EXE path). Non-'out-of-range' errors (waiver /
 * locked-mode / unsupported...) are NOT value-ceiling refusals - they never
 * degrade the store. Garbage envelopes are no-ops (never a throw).
 * @param {Map} store the session store
 * @param {number|string} deviceId the device id
 * @param {unknown} perControl the per-control result map
 * @param {unknown} settings the ATTEMPTED settings payload (the values the
 *   driver refused - the store never guesses)
 * @param {unknown} ranges the device's capability ranges (the step/min for
 *   the snap - absent per-control ranges skip that control)
 */
export function recordRefusalEnvelope(store, deviceId, perControl, settings, ranges) {
  if (!perControl || typeof perControl !== 'object' || Array.isArray(perControl)) return;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  const rangeTable = ranges && typeof ranges === 'object' ? ranges : {};
  for (const [control, result] of Object.entries(perControl)) {
    if (!result || typeof result !== 'object' || result.ok !== false || result.errorCode !== 'out-of-range') continue;
    const range = rangeTable[control];
    if (Object.prototype.hasOwnProperty.call(result, 'capabilityCeiling')) {
      if (typeof result.capabilityCeiling === 'number' && Number.isFinite(result.capabilityCeiling)) {
        recordCapabilityCeiling(store, deviceId, control, result.capabilityCeiling, range);
      }
      continue;
    }
    const value = settings[control];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    recordRefusal(store, deviceId, control, value, range);
  }
}

/**
 * M17c: merge the store's degraded maxes into a ranges table (the
 * getCapabilities response's ranges). A degraded ceiling caps the range max
 * (and the default, so the slider never offers an un-appliable value above
 * the degraded ceiling); never raises a range whose max is already below
 * the ceiling. Returns a NEW ranges object - the input is never mutated -
 * with unchanged controls keeping their identity (the pass-through pattern).
 * @param {Map} store the session store
 * @param {number|string} deviceId the device id
 * @param {Record<string, { max: number, default?: number }>} ranges the
 *   device's ranges (e.g. caps.ranges)
 * @returns {Record<string, { max: number, default?: number }>}
 */
export function mergeIntoRanges(store, deviceId, ranges) {
  if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges)) return ranges;
  const deviceMap = deviceMapOf(store, deviceId, false);
  if (!deviceMap || deviceMap.size === 0) return ranges;
  let out = null;
  for (const [control, ceiling] of deviceMap) {
    const range = ranges[control];
    if (!range || typeof range !== 'object' || typeof range.max !== 'number' || !Number.isFinite(range.max)) continue;
    if (range.max <= ceiling) continue; // never raise
    if (out === null) out = { ...ranges };
    const degraded = { ...range, max: ceiling };
    if (typeof range.default === 'number' && Number.isFinite(range.default) && range.default > ceiling) {
      degraded.default = ceiling;
    }
    out[control] = degraded;
  }
  return out ?? ranges;
}
/**
 * Return the session ceilings recorded for one device as a plain object.
 * This is an explicit marker for consumers that must distinguish a
 * session-learned lower ceiling from an ordinary stock-shaped range.
 * @param {Map} store the session store
 * @param {number|string} deviceId the device id
 * @returns {Record<string, number>}
 */
export function recordedCeilingsFor(store, deviceId) {
  const deviceMap = deviceMapOf(store, deviceId, false);
  if (!deviceMap || deviceMap.size === 0) return {};
  return Object.fromEntries([...deviceMap].filter(([, ceiling]) => (
    typeof ceiling === 'number' && Number.isFinite(ceiling)
  )));
}
