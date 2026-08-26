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
//   opengl32.dll (WITH a vendor ICD) > vulkan-1.dll > d3d12.dll > d3d11.dll
//   > d3d10.dll > d3d9.dll
// -> the canonical ids 'vulkan' | 'dx12' | 'dx11' | 'dx10' | 'dx9' | 'opengl'.
// M17c (the precedence reorder - the user's Minecraft OGL finding): the
// ICD-corroborated opengl rule moves ABOVE vulkan-1. LWJGL preloads
// vulkan-1.dll EVEN on the OpenGL path (GLFW's Vulkan probe), while the
// real GL context loads the vendor ICD - so 'vulkan-1.dll presence' is NOT
// a Vulkan signal and the M17b rank (vulkan-1 first) misread Minecraft OGL
// as Vulkan. opengl32.dll is the ONLY conditional entry - it wins ONLY
// when a vendor ICD is loaded (nvoglv64/32.dll, atiogl64/32.dll,
// amdxc64.dll, ig9icd64/32.dll - the Minecraft/LWJGL shape); a BARE
// opengl32 (the GDI-generic loader, no ICD) FALLS THROUGH to the remaining
// precedence (vulkan-1 > d3d12 > d3d11 > d3d10 > d3d9), so the GLFW-vulkan
// shape (GLFW loads opengl32.dll but no GL ICD without a GL context) still
// reads 'vulkan', and a Chromium/Electron process (incl. Arc Power's own
// window) that loads opengl32 without an ICD still reads dx11. The ICD
// only loads when a real GL context exists - the strongest loaded signal.
// dxgi.dll is loaded by ALL of them and is NOT a discriminator; d3d11 is
// loaded by Chromium too - the overlay over a browser honestly reports DX11.
// M10b (findings): vulkan-1.dll sits FIRST because it is ONLY loaded
// by Vulkan-using processes (the strongest signal - CS2 under -vulkan loads
// vulkan-1 + d3d12 + d3d11 together and must report Vulkan, not DX12), and
// d3d9.dll -> 'dx9' covers the DX9-only games (League of Legends - the
// detection list previously lacked d3d9 and LoL showed no API at all).
// M12: d3d10.dll -> 'dx10' joins after d3d11 (the DirectX-10 games load
// d3d10.dll + d3d9.dll together for the legacy fallback - d3d10 outranks
// d3d9 so a DX10 process never misreads as DX9).
// HEURISTIC LIMIT: the loaded-module scan CANNOT distinguish the ACTIVE
// renderer when a process loads several API DLLs (a D3D12 game that also
// loaded vulkan-1 reports Vulkan, and vice versa) - the precedence picks
// the strongest loaded signal, it never invents a module the process did
// not load.
// M17b (run B - the probe rework): the 'enumProcessModules' probe op now
// resolves each module's FULL PATH (GetModuleFileNameExW) and returns
// { name, path } pairs (2d-3a); the detector normalizes both shapes
// (plain names from the old fake probes still work) and feeds the run-A
// icdNames hook with the module names (basename-tolerant - 2d-3b). The
// PROCESS-TREE FALLBACK (2d-3c): when the foreground pid yields no match
// (or its handle/modules are unreadable), the detector enumerates the
// pid's CHILD processes (CreateToolhelp32Snapshot TH32CS_SNAPPROCESS -
// the new 'snapshotProcesses' probe op behind the same seam) and tries
// each child's modules - launcher-owned windows still resolve. The first
// child with a match wins; no match -> null. The primary-pid path is
// unchanged when it answers. (Final round-1 D1: the PROCESSENTRY32W
// constants are the X64 layout - dwSize 568, parentPid@32 - live-probed
// with koffi 2026-08-11; the x86 556/24 made Process32FirstW fail with
// ERROR_BAD_LENGTH and the tree could never fire. Pinned by a source
// test + the forced-fallback live probe.)
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
export const GRAPHICS_API_IDS = ['dx12', 'vulkan', 'dx11', 'dx10', 'dx9', 'opengl'];

// The module-name precedence: the FIRST matching module wins (dxgi.dll is
// loaded by every API and is deliberately absent - it is not a
// discriminator; d3d11 wins over opengl32 because Chromium loads d3d11 and
// the overlay over a browser honestly reports DX11).
// M10b (findings): vulkan-1.dll moved to the TOP - it is ONLY loaded
// by Vulkan-using processes, the strongest signal (CS2 under -vulkan loads
// vulkan-1 + d3d12 + d3d11 together and must report Vulkan, not DX12);
// d3d9.dll -> 'dx9' covers the DX9-only games (League of Legends - the
// detection list previously lacked d3d9 and LoL showed no API at all).
// M12: d3d10.dll -> 'dx10' (after d3d11, before d3d9 - the DirectX-10
// games load d3d10 + d3d9 together, and the DX10 signal must win).
// M17b (the precedence reorder): opengl32.dll moved to position 2 - but
// it is CONDITIONAL (the ICD rule in matchGraphicsApi): a bare opengl32
// (no vendor ICD) falls through to the d3d chain below, so Chromium with
// opengl32 loaded still reads dx11. The d3d chain itself is unchanged:
// d3d12 > d3d11 > d3d10 > d3d9.
// M17c (the precedence reorder - the user's Minecraft OGL finding): the
// ICD-corroborated opengl rule moves ABOVE vulkan-1. LWJGL preloads
// vulkan-1.dll EVEN on the OpenGL path (GLFW's Vulkan probe) while the
// real GL context loads the vendor ICD - 'vulkan-1.dll presence' is NOT a
// Vulkan signal, and the M17b rank misread Minecraft OGL as Vulkan. The
// CONDITIONAL opengl rule stays (a bare opengl32 falls through to
// vulkan-1 > the d3d chain - the GLFW-vulkan shape still reads 'vulkan');
// the ICD only loads when a real GL context exists - the strongest loaded
// signal.
// HEURISTIC LIMIT: the loaded-module scan cannot distinguish the ACTIVE
// renderer when a process loads several API DLLs (a D3D12 game that also
// loaded vulkan-1 reports Vulkan, and vice versa) - the precedence picks
// the strongest loaded signal, it never invents a module the process did
// not load.
const API_MODULE_PRECEDENCE = [
  ['opengl', 'opengl32.dll'], // M17c: FIRST - CONDITIONAL (wins only with a vendor ICD)
  ['vulkan', 'vulkan-1.dll'],
  ['dx12', 'd3d12.dll'],
  ['dx11', 'd3d11.dll'],
  ['dx10', 'd3d10.dll'],
  ['dx9', 'd3d9.dll'],
];

// M17b: the vendor ICD module names that corroborate a REAL OpenGL
// renderer (the Minecraft/LWJGL shape - opengl32 + the vendor ICD). The
// ICD check needs only the names (their location never matters); run B's
// { name, path } probe pairs normalize to names before the pure call.
export const VENDOR_ICD_NAMES = [
  'nvoglv64.dll', 'nvoglv32.dll',
  'atiogl64.dll', 'atiogl32.dll',
  'amdxc64.dll',
  'ig9icd64.dll', 'ig9icd32.dll',
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
// M17b (2d-3a): the full-path buffer - MAX_PATH WCHARs like the name.
const MODULE_PATH_BUFFER_WCHARS = 260;
// The module-list buffer: 512 HMODULE slots (8 bytes each on x64) - far
// beyond any real process's module count; a larger process degrades to
// null (EnumProcessModulesEx returns FALSE - the honest "cannot fully
// enumerate" answer).
const MODULE_LIST_SLOTS = 512;
// M17b (2d-3c): the process-tree snapshot - TH32CS_SNAPPROCESS + the
// PROCESSENTRY32W layout on X64 (the only build - electron-builder win,
// no arch override; live-probed 2026-08-11 with koffi, the app's own
// binding): dwSize@0, cntUsage@4, th32ProcessID@8, th32DefaultHeapID@16
// (ULONG_PTR - 8-aligned), th32ModuleID@24, cntThreads@28,
// th32ParentProcessID@32, pcPriClassBase@36, dwFlags@40, szExeFile@44
// (260 WCHARs) -> 44 + 520 = 564 -> 8-aligned 568.
// The X86 layout (dwSize 556, parentPid@24) is NOT used: with dwSize=556
// Process32FirstW fails with ERROR_BAD_LENGTH (the snapshot op silently
// returned [] - the child-tree fallback could never fire), and @24 reads
// th32ModuleID (always 0), which would drop every child.
const TH32CS_SNAPPROCESS = 0x00000002;
const PROCESSENTRY32W_SIZE = 568;
const PE32_PROCESS_ID_OFF = 8;
const PE32_PARENT_PROCESS_ID_OFF = 32;
const PROCESS_PATH_BUFFER_WCHARS = 520;

/**
 * M17b (2d-3a): normalize the probe's module enumeration into the base
 * names the pure match consumes. The op returns { name, path } PAIRS from
 * the real probe (GetModuleFileNameExW) - and plain name strings from the
 * older fake probes; both shapes normalize here. Non-string/empty entries
 * are skipped; garbage -> null (the honest degrade).
 * @param {unknown} modules the probe's enumeration (string[] or { name, path }[])
 * @returns {string[] | null}
 */
export function normalizeModuleNames(modules) {
  if (!Array.isArray(modules)) return null;
  const names = [];
  for (const m of modules) {
    if (typeof m === 'string') {
      if (m.length > 0) names.push(m);
      continue;
    }
    if (m && typeof m === 'object' && typeof m.name === 'string' && m.name.length > 0) {
      names.push(m.name);
    }
  }
  return names;
}

/**
 * The pure match (M17c: the ICD-corroborated precedence reorder).
 * Precedence: opengl32 (WITH a vendor ICD) > vulkan-1 > d3d12 > d3d11 >
 * d3d10 > d3d9. opengl32.dll sits FIRST but CONDITIONALLY - it wins ONLY
 * when a vendor ICD is loaded (nvoglv64/32.dll, atiogl64/32.dll,
 * amdxc64.dll, ig9icd64/32.dll - the Minecraft/LWJGL shape: LWJGL preloads
 * vulkan-1.dll even on the OpenGL path while the real GL context loads the
 * vendor ICD, so 'vulkan-1.dll presence' is NOT a Vulkan signal) - a BARE
 * opengl32 (the GDI-generic loader, no ICD) FALLS THROUGH to vulkan-1 >
 * the d3d precedence (the GLFW-vulkan shape: GLFW loads opengl32.dll but
 * no GL ICD without a GL context -> 'vulkan'), so Chromium/Electron with
 * opengl32 loaded still reads dx11 and an OpenGL-with-vulkan-1-loaded
 * process reads opengl (the vulkan-first misread of Minecraft OGL is
 * fixed). The ICD check reads the module names (they ARE loaded modules of
 * the process); the optional icdNames parameter is the explicit hook for
 * run B's { name, path } probe pairs (normalized to names before the
 * call). null when nothing matches - the caller renders no api field.
 * Unit-tested directly (the cheap-oracle seam).
 * @param {unknown} moduleNames the module base names (e.g. from
 *   GetModuleBaseNameW) - garbage/absent -> null
 * @param {unknown} [icdNames] optional explicit ICD names (run B's probe
 *   pairs normalized to names) - garbage/absent is ignored
 * @returns {string | null} 'vulkan' | 'dx12' | 'dx11' | 'dx10' | 'dx9' | 'opengl' | null
 */
export function matchGraphicsApi(moduleNames, icdNames) {
  if (!Array.isArray(moduleNames)) return null;
  const names = new Set(moduleNames.map((n) => (typeof n === 'string' ? n.toLowerCase() : '')));
  // The explicit ICD names: run B's { name, path } probe pairs normalize to
  // the DLL BASE NAME before the call; a full path is tolerated here too
  // (the basename after the last separator is all the check needs).
  const icds = new Set(Array.isArray(icdNames)
    ? icdNames.map((n) => (typeof n === 'string' ? n.toLowerCase().split(/[\\/]/).pop() : ''))
    : []);
  for (const [apiId, moduleName] of API_MODULE_PRECEDENCE) {
    if (!names.has(moduleName)) continue;
    if (apiId !== 'opengl') return apiId;
    // M17b: the ICD-corroborated opengl rule - opengl32 wins ONLY when a
    // vendor ICD is loaded; a bare opengl32 falls through to the d3d chain.
    const icdLoaded = VENDOR_ICD_NAMES.some((icd) => names.has(icd) || icds.has(icd));
    if (icdLoaded) return 'opengl';
    // else: fall through to the remaining d3d precedence
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
 *   skipPrimary?: boolean,  // live-probe knob: force the child-tree
 *     // fallback (detect() never opens the primary pid) - the
 *     // pipeline/live-foreground-api.mjs forced-fallback phase uses it to
 *     // prove the REAL snapshot op fires; absent -> the product default
 *     // (primary first, tree only when it does not answer)
 * }} [deps]
 */
export function createForegroundApiDetector(deps = {}) {
  const load = deps.load ?? ((name) => koffi.load(name));
  const skipPrimary = deps.skipPrimary === true;
  // The injectable call wrapper: one op per real DLL call, NORMALIZED
  // return values (the fps-dxgi callSlot pattern - a real user32/psapi
  // call cannot be faked in-process):
  //   'getForegroundWindow' () -> the hwnd (opaque) | null
  //   'getWindowThreadProcessId' (hwnd) -> the pid (number) | null
  //   'openProcess' (pid) -> the process handle (opaque) | null
  //   'getProcessImagePath' (handle) -> the executable path (string) | null
  //   'enumProcessModules' (handle) -> the module base names (string[])
  //     or the M17b { name, path } pairs | null
  //   'closeHandle' (handle) -> void
  //   'snapshotProcesses' (parentPid) -> M17b: [{ pid, parentPid }] of
  //     ALL processes (the child-tree fallback's parent filter) | null
  const probe = deps.probe ?? defaultProbe(load);

  // M17b (2d-3b): try ONE process's modules and match. The icdNames hook
  // receives the module names (the run-A basename-tolerant hook - the
  // ICD corroboration never depends on the { name, path } pair shape).
  // Never throws.
  const matchOneProcess = (handle) => {
    try {
      const modules = probe('enumProcessModules', handle);
      if (modules === null) return null; // enumeration failed (32-bit
      // ERROR_PARTIAL_COPY / protected process / buffer too small)
      const names = normalizeModuleNames(modules);
      if (names === null) return null;
      return matchGraphicsApi(names, names);
    } catch {
      return null;
    }
  };

  // M17b (2d-3c): the process-tree fallback - when the foreground pid
  // yields no match, enumerate its CHILD processes (CreateToolhelp32-
  // Snapshot TH32CS_SNAPPROCESS behind the same seam) and try each
  // child's modules. The first child with a match wins; no match ->
  // null. Every child handle closes; a protected child degrades to a
  // skip, never a throw.
  const matchChildrenOf = async (parentPid) => {
    try {
      const snapshot = probe('snapshotProcesses', parentPid);
      if (snapshot === null || !Array.isArray(snapshot)) return null;
      for (const child of snapshot) {
        if (!child || child.parentPid !== parentPid) continue;
        const handle = probe('openProcess', child.pid);
        if (!handle) continue; // protected child - try the next
        try {
          const api = matchOneProcess(handle);
          if (api !== null) return api;
        } finally {
          try { probe('closeHandle', handle); } catch { /* best effort */ }
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  /**
   * The foreground window's graphics API (the overlay's target process).
   * Every step degrades to null - NEVER throws.
   * M17b (2d-3c): when the primary pid yields no match (or its
   * handle/modules are unreadable), the pid's CHILD processes are tried
   * (launcher-owned windows) - the first child with a match wins. Under
   * the skipPrimary knob (deps) the primary is never tried - the tree is
   * the only path (the forced-fallback live probe).
   * @returns {Promise<string | null>} 'vulkan' | 'dx12' | 'dx11' | 'dx10' |
   *   'dx9' | 'opengl' or null when nothing is detected
   */
  const detect = async () => {
    try {
      const hwnd = probe('getForegroundWindow');
      if (!hwnd) return null; // no foreground window
      const pid = probe('getWindowThreadProcessId', hwnd);
      if (!pid) return null; // GetWindowThreadProcessId failed - no parent
      // id for the child-tree fallback either (it needs the foreground pid)
      // The primary path is SKIPPED under the skipPrimary knob (the
      // forced-fallback live probe) - the tree is then the ONLY path that
      // can answer.
      if (!skipPrimary) {
        const handle = probe('openProcess', pid);
        if (handle) {
          try {
            const api = matchOneProcess(handle);
            if (api !== null) return api; // the primary path answers
          } finally {
            try { probe('closeHandle', handle); } catch { /* best effort */ }
          }
        }
      }
      // M17b (2d-3c): no match from the foreground pid (or unreadable) ->
      // the child-process tree (launcher-owned windows).
      return await matchChildrenOf(pid);
    } catch {
      return null; // ANY koffi error resolves to the honest null
    }
  };

  /**
   * M17c: the foreground window's PROCESS ID (the ETW lane's
   * --process_id target). The same probe chain as detect() minus the
   * module scan - GetForegroundWindow + GetWindowThreadProcessId only.
   * Every failure resolves to null (no foreground window /
   * GetWindowThreadProcessId failed / any koffi error) - NEVER throws.
   * @returns {Promise<number | null>} the pid or null
   */
  const detectPid = async () => {
    try {
      const hwnd = probe('getForegroundWindow');
      if (!hwnd) return null; // no foreground window
      return probe('getWindowThreadProcessId', hwnd);
    } catch {
      return null; // ANY koffi error resolves to the honest null
    }
  };

  /**
   * The foreground window's process identity. This reads the image path
   * rather than enumerating modules so an executable can be matched against
   * the persisted Game Profile catalog.
   * @returns {Promise<{ pid: number, exePath: string } | null>}
   */
  const detectProcess = async () => {
    try {
      const hwnd = probe('getForegroundWindow');
      if (!hwnd) return null;
      const pid = probe('getWindowThreadProcessId', hwnd);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const handle = probe('openProcess', pid);
      if (!handle) return null;
      try {
        const exePath = probe('getProcessImagePath', handle);
        return typeof exePath === 'string' && exePath.length > 0 ? { pid, exePath } : null;
      } finally {
        try { probe('closeHandle', handle); } catch { /* best effort */ }
      }
    } catch {
      return null;
    }
  };

  return { detect, detectPid, detectProcess };
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
      queryFullProcessImageNameW: kernel32.func('QueryFullProcessImageNameW', 'int32', ['void*', 'uint32', 'void*', 'uint32*']),
      enumProcessModulesEx: psapi.func('EnumProcessModulesEx', 'int32', ['void*', 'void*', 'uint32', 'uint32*', 'uint32']),
      getModuleBaseNameW: psapi.func('GetModuleBaseNameW', 'uint32', ['void*', 'void*', 'void*', 'uint32']),
      // M17b (2d-3a): the full path per module (the { name, path } pairs).
      getModuleFileNameExW: psapi.func('GetModuleFileNameExW', 'uint32', ['void*', 'void*', 'void*', 'uint32']),
      // M17b (2d-3c): the process snapshot for the child-tree fallback.
      createToolhelp32Snapshot: kernel32.func('CreateToolhelp32Snapshot', 'void*', ['uint32', 'uint32']),
      process32FirstW: kernel32.func('Process32FirstW', 'int32', ['void*', 'void*']),
      process32NextW: kernel32.func('Process32NextW', 'int32', ['void*', 'void*']),
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
      case 'getProcessImagePath': {
        const pathBuf = koffi.alloc('uint16', PROCESS_PATH_BUFFER_WCHARS);
        const lengthBuf = koffi.alloc('uint32', 1);
        koffi.encode(lengthBuf, 0, 'uint32', PROCESS_PATH_BUFFER_WCHARS);
        const ok = f.queryFullProcessImageNameW(args[0], 0, pathBuf, lengthBuf);
        if (ok === 0) return null;
        const length = Math.min(koffi.decode(lengthBuf, 0, 'uint32'), PROCESS_PATH_BUFFER_WCHARS - 1);
        let exePath = '';
        for (let i = 0; i < length; i++) exePath += String.fromCharCode(koffi.decode(pathBuf, i * 2, 'uint16'));
        return exePath || null;
      }
      case 'enumProcessModules': {
        // One generous call (the plan's shape). FALSE -> null (the
        // ERROR_PARTIAL_COPY 32-bit-game degrade + any other failure);
        // the modules resolve to { name, path } PAIRS - the base name via
        // GetModuleBaseNameW + the FULL path via GetModuleFileNameExW
        // (M17b 2d-3a: the ICD check needs the path only to identify the
        // ICD DLL NAME - the vendor ICD names are the check, not their
        // location; the pairs also feed the run-A icdNames hook).
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
        const pathBuf = koffi.alloc('uint16', MODULE_PATH_BUFFER_WCHARS);
        const modules = [];
        for (let i = 0; i < count; i++) {
          const modulePtr = koffi.decode(buf, i * 8, 'void*');
          const len = f.getModuleBaseNameW(args[0], modulePtr, nameBuf, MODULE_NAME_BUFFER_WCHARS);
          if (len === 0) continue; // a failed name read skips that module
          let name = '';
          for (let c = 0; c < len; c++) {
            name += String.fromCharCode(koffi.decode(nameBuf, c * 2, 'uint16'));
          }
          // The full path (best effort - a failed path read keeps the name).
          let path = '';
          try {
            const plen = f.getModuleFileNameExW(args[0], modulePtr, pathBuf, MODULE_PATH_BUFFER_WCHARS);
            if (plen > 0) {
              for (let c = 0; c < plen; c++) {
                path += String.fromCharCode(koffi.decode(pathBuf, c * 2, 'uint16'));
              }
            }
          } catch { /* best effort */ }
          modules.push({ name, path });
        }
        return modules;
      }
      case 'snapshotProcesses': {
        // M17b (2d-3c): CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS) +
        // Process32FirstW/Process32NextW over PROCESSENTRY32W. The
        // snapshot handle is INVALID_HANDLE_VALUE (-1) on failure -> null.
        // The invalid-handle check accepts BOTH address forms (the raw
        // -1n pointer value AND the unsigned 0xFFFFFFFFFFFFFFFFn wrapper) -
        // the msr-reader dual-form pattern.
        const snap = f.createToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let invalid = true;
        try {
          const addr = koffi.address(snap);
          invalid = addr === 0xFFFFFFFFFFFFFFFFn || addr === -1n;
        } catch { invalid = true; }
        if (invalid) return null;
        try {
          const entry = koffi.alloc('uint8', PROCESSENTRY32W_SIZE);
          koffi.encode(entry, 0, 'uint32', PROCESSENTRY32W_SIZE); // dwSize
          const out = [];
          let ok = f.process32FirstW(snap, entry);
          while (ok) {
            out.push({
              pid: koffi.decode(entry, PE32_PROCESS_ID_OFF, 'uint32'),
              parentPid: koffi.decode(entry, PE32_PARENT_PROCESS_ID_OFF, 'uint32'),
            });
            ok = f.process32NextW(snap, entry);
          }
          return out;
        } finally {
          try { f.closeHandle(snap); } catch { /* best effort */ }
        }
      }
      case 'closeHandle':
        f.closeHandle(args[0]);
        return undefined;
      default:
        throw new Error(`foreground-api: unknown probe op '${op}'`);
    }
  };
}
