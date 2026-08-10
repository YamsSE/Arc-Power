// Arc Power - M10a foreground-window Graphics-API detector (koffi).
//
// The graphics API of the program the overlay floats over = the FOREGROUND
// window's process loaded modules (the overlay window is focusable:false +
// ignores mouse input, so GetForegroundWindow returns the window under it):
//   user32.dll GetForegroundWindow -> the hwnd;
//   GetWindowThreadProcessId(hwnd) -> the pid;
//   kernel32.dll OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION |
//     PROCESS_QUERY_INFORMATION | PROCESS_VM_READ) -> the process handle
//     (VM_READ is REQUIRED - the 2026-08-10 live-probe finding: without it
//     EnumProcessModulesEx returns ERROR_ACCESS_DENIED and the detector
//     would silently null forever);
//   psapi.dll EnumProcessModulesEx(handle, buf, size, &needed,
//     LIST_MODULES_ALL) -> the module list;
//   GetModuleBaseNameW per module -> the module base names.
// The API match (module names, case-insensitive) with the precedence
//   vulkan-1.dll > d3d12.dll > d3d11.dll > d3d9.dll > opengl32.dll
// -> the canonical ids 'vulkan' | 'dx12' | 'dx11' | 'dx9' | 'opengl'.
// dxgi.dll is loaded by ALL of them and is NOT a discriminator; d3d11 is
// loaded by Chromium too - the overlay over a browser honestly reports DX11.
// M10b (user findings): vulkan-1.dll sits FIRST because it is ONLY loaded
// by Vulkan-using processes (the strongest signal - CS2 under -vulkan loads
// vulkan-1 + d3d12 + d3d11 together and must report Vulkan, not DX12), and
// d3d9.dll -> 'dx9' covers the DX9-only games (League of Legends - the
// detection list previously lacked d3d9 and LoL showed no API at all).
// HEURISTIC LIMIT: the loaded-module scan CANNOT distinguish the ACTIVE
// renderer when a process loads several API DLLs (a D3D12 game that also
// loaded vulkan-1 reports Vulkan, and vice versa) - the precedence picks
// the strongest loaded signal, it never invents a module the process did
// not load.
//
// null on ANY failure path (access denied / protected processes / no match
// / any koffi error) - the honest degrade, NEVER a throw (the fps-dxgi
// never-throw pattern). The degrade clauses (plan-review M-7b + N-3): 32-bit
// games (EnumProcessModulesEx ERROR_PARTIAL_COPY from a 64-bit app),
// protected/elevated processes, and the overlay over Arc Power's OWN window
// (Chromium -> 'dx11' - honest) all resolve to the reported id or null.
//
// Testable (the fps-dxgi test-harness pattern): the koffi calls sit behind
// an injected seam - deps.load (the koffi loader) + deps.probe (the call
// wrapper, one op per real DLL call with NORMALIZED return values) - so the
// flow + the degrade paths are unit-testable without the real user32/psapi,
// and the pure match/precedence logic (matchGraphicsApi) is unit-tested
// directly (a process with d3d12 + d3d11 loads -> 'dx12'; a CS2-vulkan
// process with vulkan-1 + d3d12 + d3d11 loads -> 'vulkan').
//
// The DETERMINISM SEAM (plan-review M-3): main.js wires the REAL detector
// ONLY in the non-mock path - mock/ui-verify mode keeps the null-returning
// default in ipc-core, because the verify machine's own Electron/Chromium
// foreground process would honestly report 'dx11' and break the none-case
// pins nondeterministically.

import koffi from 'koffi';

// The canonical Graphics-API ids (the renderer's display labels live in
// pure/overlay.ts - the single-owner pattern like the stat ids).
export const GRAPHICS_API_IDS = ['dx12', 'vulkan', 'dx11', 'dx9', 'opengl'];

// The module-name precedence: the FIRST matching module wins (dxgi.dll is
// loaded by every API and is deliberately absent - it is not a
// discriminator; d3d11 wins over opengl32 because Chromium loads d3d11 and
// the overlay over a browser honestly reports DX11).
// M10b (user findings): vulkan-1.dll moved to the TOP - it is ONLY loaded
// by Vulkan-using processes, the strongest signal (CS2 under -vulkan loads
// vulkan-1 + d3d12 + d3d11 together and must report Vulkan, not DX12);
// d3d9.dll -> 'dx9' covers the DX9-only games (League of Legends - the
// detection list previously lacked d3d9 and LoL showed no API at all).
// HEURISTIC LIMIT: the loaded-module scan cannot distinguish the ACTIVE
// renderer when a process loads several API DLLs (a D3D12 game that also
// loaded vulkan-1 reports Vulkan, and vice versa) - the precedence picks
// the strongest loaded signal, it never invents a module the process did
// not load.
const API_MODULE_PRECEDENCE = [
  ['vulkan', 'vulkan-1.dll'],
  ['dx12', 'd3d12.dll'],
  ['dx11', 'd3d11.dll'],
  ['dx9', 'd3d9.dll'],
  ['opengl', 'opengl32.dll'],
];

// OpenProcess access rights + the psapi enumeration flag.
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// M10a live-probe finding (2026-08-10): EnumProcessModulesEx ALSO requires
// PROCESS_VM_READ - the query-only flags open the handle but the module
// enumeration returns ERROR_ACCESS_DENIED (the detector would silently
// null forever; verified live on explorer.exe + the current process).
const PROCESS_VM_READ = 0x0010;
const LIST_MODULES_ALL = 0x03;
// The module-name buffer size in WCHARs (the classic MAX_PATH-sized name).
const MODULE_NAME_BUFFER_WCHARS = 260;
// The module-list buffer: 512 HMODULE slots (8 bytes each on x64) - far
// beyond any real process's module count; a larger process degrades to
// null (EnumProcessModulesEx returns FALSE - the honest "cannot fully
// enumerate" answer).
const MODULE_LIST_SLOTS = 512;

/**
 * The pure match: the first Graphics-API id whose module name appears in
 * the list (case-insensitive). null when nothing matches - the caller
 * renders no api field. Unit-tested directly (the cheap-oracle seam).
 * @param {unknown} moduleNames the module base names (e.g. from
 *   GetModuleBaseNameW) - garbage/absent -> null
 * @returns {string | null} 'vulkan' | 'dx12' | 'dx11' | 'dx9' | 'opengl' | null
 */
export function matchGraphicsApi(moduleNames) {
  if (!Array.isArray(moduleNames)) return null;
  const names = new Set(moduleNames.map((n) => (typeof n === 'string' ? n.toLowerCase() : '')));
  for (const [apiId, moduleName] of API_MODULE_PRECEDENCE) {
    if (names.has(moduleName)) return apiId;
  }
  return null;
}

/**
 * The foreground-window Graphics-API detector. detect() runs the probe
 * chain (hwnd -> pid -> handle -> module names -> match) and NEVER throws
 * - every failure path resolves to null (the honest degrade: access
 * denied / protected processes / no match / any koffi error).
 * @param {{
 *   load?: (name: string) => object,   // injectable koffi load (tests)
 *   probe?: (op: string, ...args: unknown[]) => unknown,  // injectable call wrapper (tests)
 * }} [deps]
 */
export function createForegroundApiDetector(deps = {}) {
  const load = deps.load ?? ((name) => koffi.load(name));
  // The injectable call wrapper: one op per real DLL call, NORMALIZED
  // return values (the fps-dxgi callSlot pattern - a real user32/psapi
  // call cannot be faked in-process):
  //   'getForegroundWindow' () -> the hwnd (opaque) | null
  //   'getWindowThreadProcessId' (hwnd) -> the pid (number) | null
  //   'openProcess' (pid) -> the process handle (opaque) | null
  //   'enumProcessModules' (handle) -> the module base names (string[]) | null
  //   'closeHandle' (handle) -> void
  const probe = deps.probe ?? defaultProbe(load);

  /**
   * The foreground window's graphics API (the overlay's target process).
   * Every step degrades to null - NEVER throws.
   * @returns {Promise<string | null>} 'vulkan' | 'dx12' | 'dx11' | 'dx9' | 'opengl'
   *   or null when nothing is detected
   */
  const detect = async () => {
    try {
      const hwnd = probe('getForegroundWindow');
      if (!hwnd) return null; // no foreground window
      const pid = probe('getWindowThreadProcessId', hwnd);
      if (!pid) return null; // GetWindowThreadProcessId failed
      const handle = probe('openProcess', pid);
      if (!handle) return null; // access denied / protected process
      try {
        const names = probe('enumProcessModules', handle);
        if (names === null) return null; // enumeration failed (32-bit
        // ERROR_PARTIAL_COPY / protected process / buffer too small)
        return matchGraphicsApi(names);
      } finally {
        try { probe('closeHandle', handle); } catch { /* best effort */ }
      }
    } catch {
      return null; // ANY koffi error resolves to the honest null
    }
  };

  return { detect };
}

/**
 * The real koffi-backed probe. The DLLs load lazily on the first detect()
 * (the koffi lib.func lookups happen inside the probe closure); the
 * module-name reads decode the GetModuleBaseNameW WCHAR buffers as
 * uint16s (the fps-dxgi buffer-decode style - no koffi string types).
 * @param {(name: string) => object} load the koffi loader
 * @returns {(op: string, ...args: unknown[]) => unknown}
 */
function defaultProbe(load) {
  let funcs = null;
  const getFuncs = () => {
    if (funcs !== null) return funcs;
    const user32 = load('user32.dll');
    const kernel32 = load('kernel32.dll');
    const psapi = load('psapi.dll');
    funcs = {
      getForegroundWindow: user32.func('GetForegroundWindow', 'void*', []),
      getWindowThreadProcessId: user32.func('GetWindowThreadProcessId', 'uint32', ['void*', 'uint32*']),
      openProcess: kernel32.func('OpenProcess', 'void*', ['uint32', 'int32', 'uint32']),
      enumProcessModulesEx: psapi.func('EnumProcessModulesEx', 'int32', ['void*', 'void*', 'uint32', 'uint32*', 'uint32']),
      getModuleBaseNameW: psapi.func('GetModuleBaseNameW', 'uint32', ['void*', 'void*', 'void*', 'uint32']),
      closeHandle: kernel32.func('CloseHandle', 'int32', ['void*']),
    };
    return funcs;
  };
  return (op, ...args) => {
    const f = getFuncs();
    switch (op) {
      case 'getForegroundWindow':
        return f.getForegroundWindow();
      case 'getWindowThreadProcessId': {
        const pidBuf = koffi.alloc('uint32', 1);
        const threadId = f.getWindowThreadProcessId(args[0], pidBuf);
        if (threadId === 0) return null; // GetWindowThreadProcessId failed
        return koffi.decode(pidBuf, 0, 'uint32');
      }
      case 'openProcess':
        return f.openProcess(PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, args[0]);
      case 'enumProcessModules': {
        // One generous call (the plan's shape). FALSE -> null (the
        // ERROR_PARTIAL_COPY 32-bit-game degrade + any other failure);
        // the module base names are read one by one via GetModuleBaseNameW.
        const buf = koffi.alloc('void*', MODULE_LIST_SLOTS);
        const neededBuf = koffi.alloc('uint32', 1);
        const ok = f.enumProcessModulesEx(
          args[0],
          buf,
          MODULE_LIST_SLOTS * 8,
          neededBuf,
          LIST_MODULES_ALL,
        );
        if (ok === 0) return null;
        const needed = koffi.decode(neededBuf, 0, 'uint32');
        const count = Math.min(Math.floor(needed / 8), MODULE_LIST_SLOTS);
        const nameBuf = koffi.alloc('uint16', MODULE_NAME_BUFFER_WCHARS);
        const names = [];
        for (let i = 0; i < count; i++) {
          const modulePtr = koffi.decode(buf, i * 8, 'void*');
          const len = f.getModuleBaseNameW(args[0], modulePtr, nameBuf, MODULE_NAME_BUFFER_WCHARS);
          if (len === 0) continue; // a failed name read skips that module
          let name = '';
          for (let c = 0; c < len; c++) {
            name += String.fromCharCode(koffi.decode(nameBuf, c * 2, 'uint16'));
          }
          names.push(name);
        }
        return names;
      }
      case 'closeHandle':
        f.closeHandle(args[0]);
        return undefined;
      default:
        throw new Error(`foreground-api: unknown probe op '${op}'`);
    }
  };
}
