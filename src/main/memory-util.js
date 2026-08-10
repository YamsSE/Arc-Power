// Arc Power - M12 the RAM-utilization detector (kernel32 via koffi).
//
// GlobalMemoryStatusEx -> MEMORYSTATUSEX.dwMemoryLoad - the OS's own
// system-wide RAM utilization percentage (0-100, the number Windows Task
// Manager shows as "Memory"). The Memory overlay row + the telemetry
// sample's memoryUtilPct field are composed from this detector.
//
// MEMORYSTATUSEX layout (Windows SDK winbase.h):
//   DWORD     dwLength@0                    (must be sizeof(MEMORYSTATUSEX)
//                                            before the call - the API
//                                            rejects a zeroed length)
//   DWORD     dwMemoryLoad@4                (the percent, 0-100)
//   DWORDLONG ullTotalPhys@8, ullAvailPhys@16, ullTotalPageFile@24,
//     ullAvailPageFile@32, ullTotalVirtual@40, ullAvailVirtual@48,
//     ullAvailExtendedVirtual@56 - 64 bytes total.
// Only dwLength + dwMemoryLoad are touched; the trailing DWORDLONGs keep
// the buffer at the struct's true size so the API writes within bounds.
//
// The fps-dxgi never-throw pattern: detect() returns null on ANY failure
// path (kernel32 load failure, a bad func, the call returning FALSE, any
// koffi error) - the honest degrade, NEVER a throw.
//
// Testable (the fps-dxgi test-harness pattern): the koffi load sits behind
// an injected seam - deps.load (the koffi loader) - so the success path +
// the failure degrades are unit-testable without the real kernel32, and
// the dwMemoryLoad value passes through EXACTLY (the clobber-guard: a
// scripted 62 must come back as 62 - the 'Memory 62%' pin depends on it).

import koffi from 'koffi';

// sizeof(MEMORYSTATUSEX): 4 (dwLength) + 4 (dwMemoryLoad) + 7 x 8
// (DWORDLONGs) = 64 bytes. The dwLength field MUST carry this value before
// the call.
export const MEMORY_STATUS_EX_SIZE = 64;
// MEMORYSTATUSEX.dwMemoryLoad@4 - the utilization percent (0-100).
export const MEMORY_LOAD_OFF = 4;

/**
 * The RAM-utilization detector. detect() runs ONE GlobalMemoryStatusEx
 * call and returns dwMemoryLoad (the OS's system-wide RAM utilization
 * percent, 0-100) - or null on ANY failure (the honest degrade, NEVER a
 * throw - the fps-dxgi pattern).
 * @param {{
 *   load?: (name: string) => object,   // injectable koffi load (tests)
 * }} [deps]
 */
export function createMemoryUtilDetector(deps = {}) {
  const load = deps.load ?? ((name) => koffi.load(name));
  // The koffi func resolves LAZILY on the first detect() (the
  // foreground-api probe pattern - a failed load degrades, never throws).
  let getStatusEx = null;
  const funcOf = () => {
    if (getStatusEx !== null) return getStatusEx;
    getStatusEx = load('kernel32.dll').func('GlobalMemoryStatusEx', 'int32', ['void*']);
    return getStatusEx;
  };

  /**
   * The system-wide RAM utilization percent (0-100). Every failure path
   * degrades to null - NEVER throws.
   * @returns {Promise<number | null>} dwMemoryLoad (0-100) or null when
   *   the call failed
   */
  const detect = async () => {
    try {
      const statusEx = funcOf();
      const buf = koffi.alloc('uint8', MEMORY_STATUS_EX_SIZE);
      // The dwLength requirement: the API returns FALSE for any other
      // length, so the struct size is written FIRST (uint32 at offset 0).
      koffi.encode(buf, 0, 'uint32', MEMORY_STATUS_EX_SIZE);
      const ok = statusEx(buf);
      if (!ok) return null; // GlobalMemoryStatusEx returned FALSE
      return koffi.decode(buf, MEMORY_LOAD_OFF, 'uint32');
    } catch {
      return null; // ANY koffi error resolves to the honest null
    }
  };

  return { detect };
}
