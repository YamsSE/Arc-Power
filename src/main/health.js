// Arc Power - M1 health report aggregator.
//
// The IOCBackend.health() method reports backend-local health (igclLoaded,
// driverVersion, levelZeroOk); this module wraps it with the backend kind
// and guarantees the report shape even when the backend itself is broken.

/**
 * @typedef {import('./backend/backend.interface.js').IOCBackend} IOCBackend
 * @typedef {import('./backend/backend.interface.js').HealthReport} HealthReport
 */

/**
 * @param {IOCBackend} backend
 * @returns {Promise<HealthReport & { backend: string }>}
 */
export async function collectHealth(backend) {
  try {
    const h = await backend.health();
    return { backend: backend.kind, ...h };
  } catch (err) {
    return {
      backend: backend.kind,
      igclLoaded: false,
      driverVersion: null,
      levelZeroOk: false,
      error: err.message,
    };
  }
}
