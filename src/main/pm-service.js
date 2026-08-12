// Arc Power - M17d the PresentMon SERVICE probe (pm-service.js).
//
// The IGS-class FPS lane's gate: the driver/IGS install may ship the
// PresentMon middleware (PresentMonService.exe + PresentMonAPI2.dll - see
// pipeline/fps-igs-research.md). The probe resolves the three signals the
// fallback chain decides on:
//   serviceRunning  - an SCM service under EITHER known name is RUNNING
//                     ('PresentMonSharedService' / 'Intel PresentMon Service'
//                     - the name varies by build, probe BOTH via sc.exe);
//   dllPath         - the PresentMonAPI2.dll the lane would bind: the
//                     HKLM\SOFTWARE\INTEL\PresentMon\Service\
//                     sharedMiddlewarePath registry value first, then the
//                     fallback install paths (the service dir + the Intel
//                     Graphics Software dir - the IGS-install reality on the
//                     dev box: the DLL ships under 'Intel Graphics Software',
//                     NOT the service dir);
//   apiGeneration   - the pm3 vs api2_* generation, resolved by BIND-ONLY
//                     inspection of the DLL exports (createPmBindings - the
//                     legacy api2 generation is reported and NOT implemented:
//                     the lane degrades to the vendored console-exe lane;
//                     NEVER a vendored DLL over the driver's).
//
// LIVE DEV-BOX REALITY (2026-08-12, the implementer's probe): the registry
// value EXISTS but points at a missing DLL; the pm3 DLL (v2.5.0.0) exists
// under the IGS dir; NO SCM service under either name exists - the IGS
// service (IntelGraphicsSoftwareService) spawns PresentMonService.exe as
// its OWN CHILD PROCESS (Session 0), not as an SCM service. A live
// pmOpenSession attempt answers SESSION_ALREADY_EXISTS (the IGS overlay's
// own PresentMon64.exe holds the local ETW session) / MIDDLEWARE_NOT_FOUND
// (no shared pipe) - the pm lane is therefore NOT usable on this box and
// the fallback chain (the vendored console-exe sidecar) stays the working
// path. CRITICAL: pmGetApiVersion on the IGS DLL corrupts the heap (the
// process exits 0xC0000374 after the call) - the probe is BIND-ONLY and
// NEVER calls any pm* function (the bindings expose getApiVersion for the
// unit tests; the product path does not invoke it - flagged in the report).
//
// Every failure degrades to null/false (never a throw) - the chain decides.
//
// Electron-free (node --test) - the driver-info.js pattern (injectable
// execFile) + injectable existsSync/createBindings.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { createPmBindings } from './pm-bindings.js';

const execFile = promisify(nodeExecFile);

/** The PresentMon service names to probe (the name varies by build - the
 *  research record + the m3c evidence: probe BOTH). */
export const PRESENTMON_SERVICE_NAMES = ['PresentMonSharedService', 'Intel PresentMon Service'];
/** The HKLM PresentMon registry key the IGS installer writes the middleware
 *  DLL path into. */
export const PRESENTMON_REG_KEY = 'HKLM\\SOFTWARE\\INTEL\\PresentMon\\Service';
/** The registry value name (the sharedMiddlewarePath the service config
 *  reads). */
export const PRESENTMON_REG_VALUE = 'sharedMiddlewarePath';
/** The fallback DLL paths when the registry value is absent/unreadable:
 *  the service install dir + the Intel Graphics Software dir (the live
 *  dev-box reality - the IGS install ships the DLL under 'Intel Graphics
 *  Software'). */
export const PRESENTMON_DLL_FALLBACKS = [
  'C:\\Program Files\\Intel\\PresentMonSharedService\\PresentMonAPI2.dll',
  'C:\\Program Files\\Intel\\Intel Graphics Software\\PresentMonAPI2.dll',
];

/**
 * Parse `sc query` stdout for a RUNNING state. A service whose state line
 * reads '4 RUNNING' answers true; everything else (stopped, missing name -
 * the exit-code path) false. Garbage -> false.
 * @param {string} stdout the sc query stdout
 * @returns {boolean}
 */
export function parseScQueryRunning(stdout) {
  const m = String(stdout ?? '').match(/^\s*STATE\s*:\s*(\d+)\s+([A-Z_]+)/m);
  return m !== null && m[1] === '4' && /RUNNING/i.test(m[2]);
}

/**
 * Parse `reg query` stdout for the sharedMiddlewarePath value. The value
 * may be REG_SZ / REG_EXPAND_SZ (the IGS installer writes the expandable
 * form). Exit code 1 (value absent) -> null.
 * @param {string} stdout e.g. "    sharedMiddlewarePath    REG_EXPAND_SZ    C:\Program Files\..."
 * @param {number} [exitCode]
 * @returns {string | null}
 */
export function parseRegSharedMiddlewarePath(stdout, exitCode = 0) {
  if (exitCode === 1) return null;
  const m = String(stdout ?? '').match(/sharedMiddlewarePath\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
  if (!m) return null;
  const value = m[1].trim();
  return value.length > 0 ? value : null;
}

/**
 * The PresentMon service probe - EVERY failure degrades (never throws):
 * the sc query answers false on a missing/stopped service, the registry
 * parse null on an absent key, the DLL candidates only existing files, the
 * generation from the BIND-ONLY export inspection. The probe performs NO
 * pm* CALLS (the dev-box IGS DLL corrupts the heap on pmGetApiVersion -
 * bind-only is verified safe).
 * @param {{
 *   execFile?: typeof execFile,          // injectable sc.exe/reg.exe runner (tests)
 *   existsSync?: (p: string) => boolean, // injectable fs check (tests)
 *   createBindings?: Function,           // injectable createPmBindings (tests - the fake lib)
 *   serviceNames?: string[],             // the names to query (default PRESENTMON_SERVICE_NAMES)
 *   regKey?: string,                     // the registry key (default PRESENTMON_REG_KEY)
 *   dllFallbacks?: string[],             // the fallback DLL paths (default PRESENTMON_DLL_FALLBACKS)
 * }} [deps]
 * @returns {Promise<{
 *   serviceRunning: boolean,
 *   dllPath: string | null,
 *   apiGeneration: 'pm3' | 'api2' | null,
 *   registryDllPath: string | null,
 * }>}
 */
export async function probePresentMonService(deps = {}) {
  const exec = deps.execFile ?? execFile;
  const existsSync = deps.existsSync ?? ((p) => fs.existsSync(p));
  const createBindings = deps.createBindings ?? createPmBindings;
  const serviceNames = deps.serviceNames ?? PRESENTMON_SERVICE_NAMES;
  const regKey = deps.regKey ?? PRESENTMON_REG_KEY;
  const dllFallbacks = deps.dllFallbacks ?? PRESENTMON_DLL_FALLBACKS;

  // --- the SCM service state (BOTH names - the name varies by build) ----
  let serviceRunning = false;
  for (const name of serviceNames) {
    if (serviceRunning) break;
    try {
      const { stdout } = await exec('sc', ['query', name], { windowsHide: true });
      if (parseScQueryRunning(stdout)) serviceRunning = true;
    } catch {
      // a missing/unknown service name fails the query - the other name
      // decides (both fail -> false)
    }
  }

  // --- the registry value (the installer's middleware DLL path) ----------
  let registryDllPath = null;
  try {
    const { stdout } = await exec('reg', ['query', regKey, '/v', PRESENTMON_REG_VALUE], { windowsHide: true });
    registryDllPath = parseRegSharedMiddlewarePath(stdout, 0);
  } catch (err) {
    // reg.exe failure (missing key/value, spawn error) -> null - the
    // fallback DLL candidates decide
    registryDllPath = null;
  }

  // --- the DLL candidates: the registry value first, then the fallbacks --
  let dllPath = null;
  for (const candidate of [registryDllPath, ...dllFallbacks]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      try {
        if (existsSync(candidate)) { dllPath = candidate; break; }
      } catch { /* an fs failure degrades the candidate */ }
    }
  }

  // --- the generation: BIND-ONLY export inspection (never a pm* call) ----
  let apiGeneration = null;
  if (dllPath !== null) {
    try {
      const bindings = createBindings({ dllPath });
      apiGeneration = bindings && typeof bindings === 'object' ? (bindings.generation ?? null) : null;
    } catch {
      apiGeneration = null;
    }
  }

  return { serviceRunning, dllPath, apiGeneration, registryDllPath };
}
