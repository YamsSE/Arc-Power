// Arc Power — M4-D system-info module (electron-free).
//
// One PowerShell CIM query per session, cached at boot (the dashboard CPU
// card + the VRAM enrichment both read this). Shape:
//   {
//     cpu: { name, cores, threads, maxClockMhz },          // Win32_Processor
//     ram: { totalBytes, speedMhz|null },                  // Win32_ComputerSystem
//                                                          // + Win32_PhysicalMemory
//     videoControllers: [{ name, vramBytes|null, pnpDeviceId|null }],  // Win32_VideoController
//   }
// Fallback: when PowerShell fails/absents (non-Windows CI, sandbox, spawn
// error) the query degrades to os.cpus() + os.totalmem() — CPU name/threads/
// clock stay populated, RAM speed + video controllers degrade honestly to
// null/empty. os.cpus() cannot distinguish physical from logical cores, so
// `cores` degrades to null (never an estimate).
//
// VRAM: AdapterRAM is a 32-bit field — a >4 GB card saturates it to
// 0xFFFFFFFF / the ~2 GiB plateau (0x7FFFFFF0 — live-verified on the A770),
// so suspicious values degrade to null. The RELIABLE source is the display
// class registry subkey's `HardwareInformation.qwMemorySize` (UInt64 bytes,
// matched to the controller by PNPDeviceID prefix) — it wins over AdapterRAM
// whenever present, so the real A770 reports its TRUE 16 GiB and the device
// name gains the honest "16 GB" suffix (M4-D user addition, live-verified).
// The honest value flows into formatDeviceName via the backend's vramBytesOf
// provider (igcl-backend.js).
//
// Mock mode: createMockSysinfo() is the default IPC adapter (tests and
// --ui-verify never spawn PowerShell); the product path injects the real
// query result in main.js.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFile = promisify(nodeExecFile);

export const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// The module-level session cache: "cached at boot (one query per session)".
let cached = null;

/**
 * The PowerShell CIM query: Win32_Processor (Name/NumberOfCores/
 * NumberOfLogicalProcessors/MaxClockSpeed), Win32_ComputerSystem
 * (TotalPhysicalMemory), Win32_PhysicalMemory (Manufacturer/
 * ConfiguredClockSpeed — the RAM brand for the bundled memory row),
 * Win32_VideoController (Name/AdapterRAM/PNPDeviceID), the display class
 * registry subkeys' HardwareInformation.qwMemorySize (UInt64 bytes, keyed
 * by MatchingDeviceId), and — per video controller — the PCIe link
 * properties (DEVPKEY_PciDevice_CurrentLinkSpeed/Width + Max) and the
 * pnputil resource ranges (the ReBAR check: a functioning Resizable BAR
 * shows a multi-GiB memory BAR). Serialized to JSON by PowerShell itself
 * (the parse side stays dumb). A missing class on a stripped-down system
 * serializes as null/[] — the parser degrades those honestly.
 * @returns {string}
 */
export function buildSysinfoScript() {
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed',
    '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 TotalPhysicalMemory',
    '$mem = Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1 Manufacturer,ConfiguredClockSpeed',
    '$vga = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,PNPDeviceID)',
    '$regMem = @(Get-ChildItem \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.\'HardwareInformation.qwMemorySize\' -and $p.MatchingDeviceId) { [pscustomobject]@{ PNPDeviceID = $p.MatchingDeviceId; MemoryBytes = $p.\'HardwareInformation.qwMemorySize\' } } })',
    '$vga = @($vga | ForEach-Object { $id = $_.PNPDeviceID; $p = @(Get-PnpDeviceProperty -InstanceId $id -KeyName \'DEVPKEY_PciDevice_CurrentLinkSpeed\',\'DEVPKEY_PciDevice_CurrentLinkWidth\',\'DEVPKEY_PciDevice_MaxLinkSpeed\',\'DEVPKEY_PciDevice_MaxLinkWidth\'); $links = @{}; foreach ($pr in $p) { $links[$pr.KeyName] = $pr.Data }; $res = & pnputil /enum-devices /instanceid $id /resources /format txt 2>$null; $barMax = 0; if ($res) { $res | ForEach-Object { if ($_ -match \'^Memory Resources:\\s*0x([0-9A-Fa-f]+)\\s*-\\s*0x([0-9A-Fa-f]+)\') { $sz = [Convert]::ToInt64($matches[2],16) - [Convert]::ToInt64($matches[1],16) + 1; if ($sz -gt $barMax) { $barMax = $sz } } } }; [pscustomobject]@{ Name = $_.Name; AdapterRAM = $_.AdapterRAM; PNPDeviceID = $id; CurrentLinkSpeed = $links[\'DEVPKEY_PciDevice_CurrentLinkSpeed\']; CurrentLinkWidth = $links[\'DEVPKEY_PciDevice_CurrentLinkWidth\']; MaxLinkSpeed = $links[\'DEVPKEY_PciDevice_MaxLinkSpeed\']; MaxLinkWidth = $links[\'DEVPKEY_PciDevice_MaxLinkWidth\']; MaxBarBytes = $barMax } })',
    '[pscustomobject]@{ cpu = $cpu; computerSystem = $cs; physicalMemory = $mem; videoControllers = $vga; registryMemory = $regMem } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
}

/**
 * M4-D: AdapterRAM -> vramBytes (the FALLBACK source). AdapterRAM is a
 * 32-bit field whose saturation sentinels carry no byte count: 0xFFFFFFFF
 * (>4 GB cards saturate to it), 0x7FFFFFFF and 0x80000000 (common
 * "unknown" values), the ~2 GiB plateau (0x7FFFFFF0 family — live-verified
 * on the A770, which is really 16 GiB), and 0 / negative / non-finite.
 * Those degrade to null so the UI never prints a wrong VRAM figure. Any
 * other positive value is a trustworthy byte count for a genuinely small
 * adapter (the real CIM field is a UInt32, so values above 0xFFFFFFFF can
 * only come from fixtures — still honest).
 * @param {unknown} value
 * @returns {number | null}
 */
export function vramBytesFromAdapterRam(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const v = Math.floor(value);
  if (v === 0xFFFFFFFF || v === 0x7FFFFFFF || v === 0x80000000 || v >= 0x7FF00000) return null;
  return v;
}

/**
 * The reliable VRAM source: the display-class registry subkeys'
 * HardwareInformation.qwMemorySize (UInt64 bytes) keyed by MatchingDeviceId
 * ("PCI\VEN_8086&DEV_56A0&SUBSYS_...") — matched to a controller by
 * PNPDeviceID PREFIX (the controller's full ID carries the instance
 * suffix). Prefer the registry value over AdapterRAM whenever it exists.
 * @param {Array<{ pnpDeviceId: string|null }>} controllers the parsed
 *   video controllers (each gains vramBytes)
 * @param {Array<{ PNPDeviceID?: unknown, MemoryBytes?: unknown }>} registryMemory
 *   the raw parsed registry rows
 */
export function applyRegistryMemory(controllers, registryMemory) {
  const rows = Array.isArray(registryMemory) ? registryMemory : [];
  return controllers.map((c) => {
    if (!c.pnpDeviceId) return c;
    const row = rows.find((r) => {
      const devId = typeof r?.PNPDeviceID === 'string' ? r.PNPDeviceID : '';
      const mem = r?.MemoryBytes;
      return devId.length > 0
        && typeof mem === 'number' && Number.isFinite(mem) && mem > 0
        && (devId === c.pnpDeviceId || c.pnpDeviceId.startsWith(devId));
    });
    // The registry UInt64 is the RELIABLE source — it wins over the
    // 32-bit AdapterRAM whenever it exists.
    return row ? { ...c, vramBytes: Math.floor(row.MemoryBytes) } : c;
  });
}

/**
 * PCIe link-speed code -> Gen label (PCI_EXPRESS_LINK_SPEED codes):
 * 1 = 2.5 GT/s (Gen1) ... 5 = 32 GT/s (Gen5).
 * @param {unknown} code
 * @returns {number|null} the Gen number, or null when unknown
 */
export function pcieGenFromCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code) || code < 1 || code > 5) return null;
  return code;
}

/**
 * M4-D (user): the PCIe link row. The kernel's PciDevice properties can be
 * UNPOPULATED on some platforms (live-verified here: the A770 behind a PCIe
 * switch reports the all-defaults 1/1/1/1 pattern — Max=Gen1 x1 is
 * impossible for a Gen4 card, so the row honestly degrades to null instead
 * of printing a wrong link). When populated (currentSpeed/currentWidth sane
 * or maxSpeed >= 2), report the CURRENTLY-USED link ("PCIe 4.0 x16").
 * @param {object} c raw controller row
 * @returns {{ currentGen: number|null, currentWidth: number|null, maxGen: number|null, maxWidth: number|null } | null}
 */
export function pcieFromController(c) {
  const currentSpeed = typeof c?.CurrentLinkSpeed === 'number' ? c.CurrentLinkSpeed : null;
  const currentWidth = typeof c?.CurrentLinkWidth === 'number' ? c.CurrentLinkWidth : null;
  const maxSpeed = typeof c?.MaxLinkSpeed === 'number' ? c.MaxLinkSpeed : null;
  const maxWidth = typeof c?.MaxLinkWidth === 'number' ? c.MaxLinkWidth : null;
  // Nothing populated -> unknown; the unpopulated-defaults pattern
  // (everything 1/1 — live-verified here: the A770 behind a PCIe switch)
  // is also unknown: Max=Gen1 x1 is impossible for a Gen4 card, so the
  // row honestly degrades to null instead of printing a wrong link.
  if (currentSpeed === null && currentWidth === null && maxSpeed === null && maxWidth === null) return null;
  if (currentSpeed === 1 && currentWidth === 1 && maxSpeed === 1 && maxWidth === 1) return null;
  return {
    currentGen: pcieGenFromCode(currentSpeed),
    currentWidth,
    maxGen: pcieGenFromCode(maxSpeed),
    maxWidth,
  };
}

/**
 * M4-D (user): the ReBAR verdict — a functioning Resizable BAR shows a
 * multi-GiB memory BAR in the device resources (the A770's non-ReBAR
 * aperture is 16 MB; with ReBAR the BAR spans the full VRAM). True when
 * the largest memory range is >= 1 GiB; false otherwise (unknown when no
 * resource info). Live-verified on this machine: 16 MB -> false (ReBAR off).
 * @param {unknown} maxBarBytes
 * @returns {boolean|null}
 */
export function rebarFromMaxBarBytes(maxBarBytes) {
  if (typeof maxBarBytes !== 'number' || !Number.isFinite(maxBarBytes) || maxBarBytes <= 0) return null;
  return maxBarBytes >= 1024 * 1024 * 1024;
}

/**
 * Parse the PowerShell JSON output into the canonical sysinfo shape. Any
 * missing/unparseable piece degrades per-field (null / empty array) — the
 * query result is a best-effort read, never a boot blocker.
 * @param {string} stdout
 * @returns {{ cpu: object, ram: object, videoControllers: object[] }}
 */
export function parseCimOutput(stdout) {
  let raw = null;
  try {
    raw = JSON.parse(String(stdout ?? ''));
  } catch {
    // Garbage output (UAC prompt interleaved, PS 2 vs 5 quirks) degrades to
    // the fallback shape's empties — the caller decides whether to fall back.
    return { cpu: {}, ram: {}, videoControllers: [] };
  }
  const cpuRaw = raw && typeof raw === 'object' ? raw.cpu : null;
  const csRaw = raw && typeof raw === 'object' ? raw.computerSystem : null;
  const memRaw = raw && typeof raw === 'object' ? raw.physicalMemory : null;
  const vgaRaw = Array.isArray(raw?.videoControllers) ? raw.videoControllers : [];

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const cpu = {
    name: typeof cpuRaw?.Name === 'string' && cpuRaw.Name ? cpuRaw.Name : null,
    cores: num(cpuRaw?.NumberOfCores),
    threads: num(cpuRaw?.NumberOfLogicalProcessors),
    maxClockMhz: num(cpuRaw?.MaxClockSpeed),
  };
  const ram = {
    totalBytes: num(csRaw?.TotalPhysicalMemory) ?? 0,
    speedMhz: num(memRaw?.ConfiguredClockSpeed),
    manufacturer: typeof memRaw?.Manufacturer === 'string' && memRaw.Manufacturer ? memRaw.Manufacturer : null,
  };
  const videoControllers = applyRegistryMemory(
    vgaRaw
      .map((c) => ({
        name: typeof c?.Name === 'string' ? c.Name : null,
        vramBytes: vramBytesFromAdapterRam(c?.AdapterRAM),
        pnpDeviceId: typeof c?.PNPDeviceID === 'string' && c.PNPDeviceID ? c.PNPDeviceID : null,
        pcie: pcieFromController(c),
        rebarActive: rebarFromMaxBarBytes(c?.MaxBarBytes),
      }))
      .filter((c) => c.name !== null),
    raw?.registryMemory,
  );
  return { cpu, ram, videoControllers };
}

/**
 * M4-D (user): the honest os.cpus()/os.totalmem() fallback shape — RAM
 * speed + video controllers degrade to null/empty (there is no OS-level
 * source for them), and `cores` degrades to null because os.cpus() cannot
 * distinguish physical from logical cores (never an estimate).
 * @returns {{ cpu: object, ram: object, videoControllers: [] }}
 */
export function fallbackSysinfo() {
  const cpus = os.cpus();
  const cpu = cpus.length > 0
    ? { name: cpus[0].model, cores: null, threads: cpus.length, maxClockMhz: cpus[0].speed }
    : { name: null, cores: null, threads: null, maxClockMhz: null };
  return {
    cpu,
    ram: { totalBytes: os.totalmem(), speedMhz: null, manufacturer: null },
    videoControllers: [],
  };
}

/**
 * Run the CIM query ONCE per session (module-level cache) with the
 * injectable execFile (tests pass a fake; the product path never runs
 * PowerShell in mock mode — main.js injects createMockSysinfo() there).
 * Any query failure (PowerShell absent, spawn error, timeout, garbage
 * output) falls back to os.cpus()/os.totalmem() — never throws. The query
 * timeout is SHORT (10 s — M4-D review F3): a hung PowerShell must not
 * block the first window for a minute (the real CIM query completes in
 * 1-5 s); the timeout rejection lands in the same os.cpus() fallback.
 * @param {{ execFile?: typeof execFile, powershellExe?: string, timeoutMs?: number }} [deps]
 * @returns {Promise<{ cpu: object, ram: object, videoControllers: object[] }>}
 */
export async function collectSysinfo(deps = {}) {
  if (cached) return cached;
  const exec = deps.execFile ?? execFile;
  try {
    const { stdout } = await exec(
      deps.powershellExe ?? POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-Command', buildSysinfoScript()],
      { windowsHide: true, timeout: deps.timeoutMs ?? 10000 },
    );
    const parsed = parseCimOutput(stdout);
    if (typeof parsed.cpu?.name !== 'string' || parsed.cpu.name.length === 0) {
      // No usable CPU row (garbage output, PS 2 quirks, empty classes) —
      // the honest os.cpus() fallback, same as a PowerShell failure.
      cached = fallbackSysinfo();
    } else {
      cached = {
        cpu: {
          name: parsed.cpu.name,
          cores: parsed.cpu.cores,
          threads: parsed.cpu.threads,
          maxClockMhz: parsed.cpu.maxClockMhz,
        },
        ram: {
          totalBytes: parsed.ram?.totalBytes || os.totalmem(),
          speedMhz: parsed.ram?.speedMhz ?? null,
          manufacturer: parsed.ram?.manufacturer ?? null,
        },
        videoControllers: parsed.videoControllers ?? [],
      };
    }
  } catch {
    // PowerShell failed/absent -> the honest os.cpus() fallback.
    cached = fallbackSysinfo();
  }
  return cached;
}

/**
 * Reset the session cache (tests only — each test pins its own fallback).
 */
export function resetSysinfoCache() {
  cached = null;
}

// ---------------------------------------------------------------------------
// VRAM enrichment (M4-D user addition) — matching the IGCL device name
// against the CIM video-controller list, with the honest fallback chain.
// ---------------------------------------------------------------------------

// Family tokens that identify a GPU product line in a controller name.
const GPU_FAMILY_TOKENS = new Set(['arc', 'iris', 'uhd', 'hd', 'hdg']);
// Tokens that carry no model information (trademark/legal/generic words).
const GENERIC_TOKENS = new Set(['r', 'tm', 'intel', 'graphics', 'gpu', 'controller', 'display', 'family', 'adapters']);

function tokensOf(name) {
  return new Set(String(name ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Match the IGCL device name against the CIM video-controller list:
 *   1. exact normalized name equality (the common case — both sources name
 *      the card the same way);
 *   2. GPU-family token match — a shared family token (e.g. 'arc') PLUS at
 *      least one shared non-family model token (e.g. 'a770'). A bare family
 *      token never satisfies this path: 'Intel(R) Arc(TM) Graphics' (no
 *      model token) and 'Intel Arc A750' against an A770 row must NOT claim
 *      the A770's VRAM — a wrong cross-card match prints a WRONG number,
 *      worse than an honest null (M4-D review F1);
 *   3. the primary non-basic adapter — ONLY for model-less device names
 *      (every token is generic/family, e.g. 'Intel(R) Arc(TM) Graphics'):
 *      the first controller that is not a basic-display/Microsoft fallback
 *      adapter (the dGPU is normally listed first). A name that names a
 *      SPECIFIC model (e.g. 'A750') which matched no controller degrades
 *      honestly to null — the fallback must never attach a different
 *      card's VRAM to a different-model name;
 *   4. null when nothing matches (honest: no VRAM claim without a match).
 * @param {string} deviceName the IGCL device name (pre-suffix)
 * @param {Array<{ name: string|null, vramBytes: number|null, pnpDeviceId: string|null }>} videoControllers
 * @returns {object | null}
 */
export function matchVideoController(deviceName, videoControllers) {
  const list = Array.isArray(videoControllers) ? videoControllers : [];
  if (!deviceName || list.length === 0) return null;
  const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const target = normalize(deviceName);
  if (!target) return null;

  // 1. exact normalized equality.
  const exact = list.find((c) => c.name && normalize(c.name) === target);
  if (exact) return exact;

  // 2. GPU-family token match: the family token is NOT enough — a shared
  // NON-family token (a real model token like 'a770') is required too.
  const targetTokens = tokensOf(deviceName);
  for (const c of list) {
    if (!c.name) continue;
    const cTokens = tokensOf(c.name);
    const shared = [...targetTokens].filter((t) => cTokens.has(t) && !GENERIC_TOKENS.has(t));
    const familyShared = [...targetTokens].filter((t) => cTokens.has(t) && GPU_FAMILY_TOKENS.has(t));
    const modelShared = shared.filter((t) => !GPU_FAMILY_TOKENS.has(t));
    if (familyShared.length > 0 && modelShared.length >= 1) return c;
  }

  // 3. primary non-basic adapter — only for a MODEL-LESS device name (all
  // tokens generic/family). A name carrying a model token that matched no
  // controller is an unmatched specific card -> honest null, never a wrong
  // cross-model VRAM claim.
  const hasModelToken = [...targetTokens]
    .some((t) => !GENERIC_TOKENS.has(t) && !GPU_FAMILY_TOKENS.has(t));
  if (!hasModelToken) {
    const primary = list.find((c) => c.name && !/basic|microsoft/i.test(c.name));
    if (primary) return primary;
  }
  return null;
}

/**
 * The vramBytesOf provider wired into IgclBackend (main.js real path):
 * match the device against the cached sysinfo and return its vramBytes
 * (null when unmatched/degraded — formatDeviceName then keeps the plain
 * name).
 * @param {{ name?: string }} device
 * @param {{ videoControllers?: Array<{ name: string|null, vramBytes: number|null, pnpDeviceId: string|null }> } | null} sysinfo
 * @returns {number | null}
 */
export function vramBytesOfDevice(device, sysinfo) {
  const controllers = Array.isArray(sysinfo?.videoControllers) ? sysinfo.videoControllers : [];
  if (controllers.length === 0) return null;
  const match = matchVideoController(device?.name ?? '', controllers);
  return match && Number.isInteger(match.vramBytes) && match.vramBytes > 0 ? match.vramBytes : null;
}

/**
 * In-memory fixture — the default sysinfo adapter for tests and --ui-verify
 * (never spawns PowerShell). Fixed values so the dashboard CPU card and the
 * sysinfo IPC payload are deterministic in mock mode.
 * @param {{ cpu?: object, ram?: object, videoControllers?: object[] }} [overrides]
 */
export function createMockSysinfo(overrides = {}) {
  return {
    get: async () => ({
      cpu: {
        name: 'Intel(R) Core(TM) i7-14700K',
        cores: 20,
        threads: 28,
        maxClockMhz: 5600,
        ...(overrides.cpu ?? {}),
      },
      ram: {
        totalBytes: 34359738368, // 32 GiB
        speedMhz: 6000,
        manufacturer: 'G.Skill',
        ...(overrides.ram ?? {}),
      },
      videoControllers: [
        {
          name: 'Intel(R) Arc(TM) A770 Graphics',
          vramBytes: 17179869184, // 16 GiB (the 16 GB config)
          pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08',
          pcie: { currentGen: 4, currentWidth: 16, maxGen: 4, maxWidth: 16 },
          rebarActive: true,
        },
        ...(overrides.videoControllers ?? []),
      ],
    }),
  };
}
