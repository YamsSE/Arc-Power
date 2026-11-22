import { currentBrokerApplyTransactionSequence } from './apply-lock.js';

// A refusal ceiling cannot be used safely if the broker failed to publish it.
// Keep the poison scoped to the unified backend instance (which is shared by
// direct, profile, boot, and tray broker paths), never to a volatile device ID.
const unavailableByBackend = new WeakMap();
const unavailableGenerationByBackend = new WeakMap();

export const TEMPERATURE_REFUSAL_CACHE_UNAVAILABLE_MESSAGE =
  'The temperature refusal cache is unavailable after a driver refusal could not be recorded. Restart Arc Power before applying a temperature limit.';

export async function markTemperatureRefusalCacheUnavailable(backend, error = null) {
  if (!backend || (typeof backend !== 'object' && typeof backend !== 'function')) return;
  const detail = error instanceof Error ? error.message : error == null ? '' : String(error);
  if (!unavailableByBackend.has(backend)) {
    const cacheGeneration = backend.getTemperatureRefusalCacheGeneration?.();
    const current = Math.max(
      Number.isSafeInteger(cacheGeneration) && cacheGeneration >= 0 ? cacheGeneration : 0,
      unavailableGenerationByBackend.get(backend) ?? 0,
    );
    unavailableGenerationByBackend.set(backend, current < Number.MAX_SAFE_INTEGER ? current + 1 : current);
  }
  unavailableByBackend.set(backend, detail || 'refusal publication failed');
  if (typeof backend.poisonTemperatureRefusalCache === 'function') {
    const poisoned = await backend.poisonTemperatureRefusalCache(detail || 'refusal publication failed');
    if (poisoned !== true) throw new Error('Temperature refusal cache poison was not acknowledged');
  }
}

export function temperatureRefusalCacheFailure(backend) {
  if (!backend || (typeof backend !== 'object' && typeof backend !== 'function')) return null;
  const detail = unavailableByBackend.get(backend);
  if (detail !== undefined) return { detail };
  try { return backend.getTemperatureRefusalCacheFailure?.() ?? null; }
  catch (error) { return { detail: error instanceof Error ? error.message : 'native refusal cache state is unavailable' }; }
}

/** Current generation across learned ceilings and the process-lifetime poison latch. */
export function temperatureRefusalCacheGeneration(backend) {
  if (!backend || (typeof backend !== 'object' && typeof backend !== 'function')) return 0;
  let backendGeneration = 0;
  try {
    const value = backend.getTemperatureRefusalCacheGeneration?.();
    if (Number.isSafeInteger(value) && value >= 0) backendGeneration = value;
  } catch { /* a failed generation read is not a cache miss */ }
  return Math.max(backendGeneration, unavailableGenerationByBackend.get(backend) ?? 0);
}

/**
 * Await refusal-cache publication before releasing the broker transaction.
 * A malformed result for an attempted temperature write is treated as an
 * unknown outcome and poisons the cache. If an actual temperature ceiling
 * refusal cannot be published, the same fail-closed latch prevents future
 * temperature writes through this backend instance.
 */
export async function recordApplyRefusalsSafely(backend, deviceId, envelope, settings, publicationOptions = {}) {
  const attemptedTemperature = Number.isFinite(settings?.tempLimitC);
  if (!envelope || typeof envelope !== 'object') {
    if (attemptedTemperature) await markTemperatureRefusalCacheUnavailable(backend, 'malformed apply result');
    return attemptedTemperature ? 'unavailable' : 'not-required';
  }
  const result = envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope;
  if (envelope.ocModeRefused === true || result.ocModeRefused === true
    || (envelope.extendedUnavailable === true && envelope.extendedUnavailablePartial !== true)
    || (result.extendedUnavailable === true && result.extendedUnavailablePartial !== true)) return 'not-required';

  const temp = result.perControl && typeof result.perControl === 'object'
    ? result.perControl.tempLimitC
    : undefined;
  if (attemptedTemperature && (!temp || typeof temp !== 'object' || typeof temp.ok !== 'boolean'
    || (temp.ok === false && typeof temp.errorCode !== 'string'))) {
    await markTemperatureRefusalCacheUnavailable(backend, 'malformed temperature result');
    return 'unavailable';
  }
  const publicationRequiredForTemperature = temp?.ok === false && temp.errorCode === 'out-of-range';
  if (publicationRequiredForTemperature && !attemptedTemperature) {
    await markTemperatureRefusalCacheUnavailable(backend, 'temperature refusal has no finite attempted value');
    return 'unavailable';
  }

  if (typeof backend?.recordApplyRefusals !== 'function') {
    if (publicationRequiredForTemperature) {
      await markTemperatureRefusalCacheUnavailable(backend, 'refusal recorder is unavailable');
    }
    return publicationRequiredForTemperature ? 'unavailable' : 'not-required';
  }
  try {
    const recorded = await backend.recordApplyRefusals(deviceId, result, settings, {
      ...publicationOptions,
      transactionSequence: publicationOptions.transactionSequence ?? currentBrokerApplyTransactionSequence(),
    });
    if (publicationRequiredForTemperature && recorded !== true) {
      await markTemperatureRefusalCacheUnavailable(backend, 'refusal recorder rejected publication');
      return 'unavailable';
    }
    return publicationRequiredForTemperature ? 'committed' : 'not-required';
  } catch (error) {
    if (publicationRequiredForTemperature) await markTemperatureRefusalCacheUnavailable(backend, error);
    return publicationRequiredForTemperature ? 'unavailable' : 'not-required';
  }
}
