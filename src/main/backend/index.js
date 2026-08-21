// Arc Power - M1 backend factory: real (IGCL) vs mock via env/opts.
// The sidecar bridge is a future fallback (plan §2) behind the same
// IOCBackend interface - not built in M1.

import { IgclBackend } from './igcl-backend.js';
import { MockBackend } from './mock-backend.js';

/**
 * Create an IOCBackend.
 * Selection order: opts.kind -> RID_BACKEND env -> 'igcl'.
 *   kind 'mock' -> MockBackend (fixtures / demo / tests)
 *   kind 'igcl' -> IgclBackend (koffi -> IntelControlLib.dll)
 * IgclBackend opts (opts.igcl): dllPath / allowAutoWaiver / lib / findDll /
 *   extended - the M2C-C/M41 bundled-2023-runtime capability adapter
 *   ({ extended: { isCapable: () => oldIgcl.isCapable(),
 *                  isAvailable: () => oldIgcl.isAvailable() } }), forwarded
 *   verbatim by this factory.
 * @param {{ kind?: 'igcl'|'mock', igcl?: object, mock?: object }} opts
 * @returns {import('./backend.interface.js').IOCBackend}
 */
export function createBackend(opts = {}) {
  const kind = opts.kind ?? process.env.RID_BACKEND ?? 'igcl';
  if (kind === 'mock') return new MockBackend(opts.mock ?? {});
  if (kind === 'igcl') return new IgclBackend(opts.igcl ?? {});
  throw new Error(`Unknown backend kind: ${kind} (expected 'igcl' or 'mock')`);
}
