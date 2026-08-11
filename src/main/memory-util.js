// Arc Power - M12/M14 the RAM-utilization detector (kernel32 via koffi).
//
// M14: GlobalMemoryStatusEx -> MEMORYSTATUSEX.ullTotalPhys + ullAvailPhys -
// the detector returns the system-wide USED RAM in BYTES (total - avail,
// the source of the overlay row's 'RAM 12.4 GB'). The old dwMemoryLoad
// percent is superseded: the user asked for the used GB, and the used
// bytes derive from the same single call (no extra polling).
//
// MEMORYSTATUSEX layout (Windows SDK winbase.h):
//   DWORD     dwLength@0                    (must be sizeof(MEMORYSTATUSEX)
//                                            before the call - the API
//                                            rejects a zeroed length)
//   DWORD     dwMemoryLoad@4                (the percent, 0-100 - read for
//                                            completeness, not used)
//   DWORDLONG ullTotalPhys@8, ullAvailPhys@16, ullTotalPageFile@24,
//     ullAvailPageFile@32, ullTotalVirtual@40, ullAvailVirtual@48,
//     ullAvailExtendedVirtual@56 - 64 bytes total.
// The trailing DWORDLONGs keep the buffer at the struct's true size so the
// API writes within bounds.
//
// The fps-dxgi never-throw pattern: detect() returns null on ANY failure
// path (kernel32 load failure, a bad func, the call returning FALSE, any
// koffi error, an impossible negative used-bytes) - the honest degrade,
// NEVER a throw.
//
// Testable (the fps-dxgi test-harness pattern): the koffi load sits behind
// an injected seam - deps.load (the koffi loader) - so the success path +
// the failure degrades are unit-testable without the real kernel32, and
// the scripted total/avail come back EXACTLY (the clobber-guard: scripted
// 12.4 GB used must come back as 12400000000 - the 'RAM 12.4 GB' pin
// depends on it).

import koffi from 'koffi';

// sizeof(MEMORYSTATUSEX): 4 (dwLength) + 4 (dwMemoryLoad) + 7 x 8
// (DWORDLONGs) = 64 bytes. The dwLength field MUST carry this value before
// the call.
export const MEMORY_STATUS_EX_SIZE = 64;
// M14: MEMORYSTATUSEX.ullTotalPhys@8 + ullAvailPhys@16 - the used-bytes
// source (the 'RAM 12.4 GB' row).
export const TOTAL_PHYS_OFF = 8;
export const AVAIL_PHYS_OFF = 16;

/**
 * The RAM-utilization detector. detect() runs ONE GlobalMemoryStatusEx
 * call and returns the system-wide USED RAM in BYTES (total - avail) - or
 * null on ANY failure (the honest degrade, NEVER a throw - the fps-dxgi
 * pattern).
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
   * The system-wide used RAM in bytes (ullTotalPhys - ullAvailPhys, the
   * 'RAM 12.4 GB' row's source). Every failure path degrades to null -
   * NEVER throws.
   * @returns {Promise<number | null>} the used bytes or null when the
   *   call failed
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
      const total = Number(koffi.decode(buf, TOTAL_PHYS_OFF, 'uint64'));
      const avail = Number(koffi.decode(buf, AVAIL_PHYS_OFF, 'uint64'));
      const used = total - avail;
      return Number.isFinite(used) && used >= 0 ? used : null;
    } catch {
      return null; // ANY koffi error resolves to the honest null
    }
  };

  return { detect };
}
