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
 * NumberOfLogicalProcessors/MaxClockSpeed + M4-H L1CacheSize/L2CacheSize/
 * L3CacheSize — KB, the Caches row source), Win32_ComputerSystem
 * (TotalPhysicalMemory), Win32_PhysicalMemory (Manufacturer/
 * ConfiguredClockSpeed/SMBIOSMemoryType — the RAM brand for the bundled
 * memory row; the Manufacturer is the raw SPD JEDEC hex code, decoded by
 * jedecBrand in the parse; SMBIOSMemoryType is the Type-17 code the
 * dashboard's DDR5-style label derives from), Win32_VideoController
 * (Name/AdapterRAM/PNPDeviceID), the display
 * class registry subkeys' HardwareInformation.qwMemorySize (UInt64 bytes,
 * keyed by MatchingDeviceId), and per video controller — the pnputil
 * resource ranges (the ReBAR check: a functioning Resizable BAR shows a
 * multi-GiB memory BAR) PLUS the Win32_AllocatedResource cross-check
 * (Win32_DeviceMemoryAddress ranges joined to the controller by its
 * Win32_VideoController DeviceID — the second ReBAR source; M4-D2 §3).
 * M4-D2: the PCIe-link property queries are REMOVED (the row was removed —
 * the unpopulated 1/1 pattern made it a permanent '—' on this machine).
 * Serialized to JSON by PowerShell itself (the parse side stays dumb). A
 * missing class on a stripped-down system serializes as null/[] — the
 * parser degrades those honestly.
 * @returns {string}
 */
export function buildSysinfoScript() {
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,L1CacheSize,L2CacheSize,L3CacheSize',
    '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 TotalPhysicalMemory',
    // M4-H: the memory row also reads SMBIOSMemoryType (the Type-17 code —
    // 34 = DDR5 on the mock; the parse maps it, anything unknown is omitted).
    '$mem = Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1 Manufacturer,ConfiguredClockSpeed,SMBIOSMemoryType',
    '$vga = @(Get-CimInstance Win32_VideoController | Select-Object DeviceID,Name,AdapterRAM,PNPDeviceID)',
    '$regMem = @(Get-ChildItem \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.\'HardwareInformation.qwMemorySize\' -and $p.MatchingDeviceId) { [pscustomobject]@{ PNPDeviceID = $p.MatchingDeviceId; MemoryBytes = $p.\'HardwareInformation.qwMemorySize\' } } })',
    // M4-D2: per-controller ReBAR sources. (a) pnputil memory resources —
    // the ONE-LINE layout ("Memory Resources: 0x... - 0x...",
    // live-verified on the A770). The indented two-line layout (the label
    // on its own line, the range indented on the NEXT line) is NOT matched
    // by this per-line -match — machines with that layout are covered by
    // the (b) allocated-resource cross-check (the plan's second source).
    // (b) the allocated-resource
    // cross-check: Win32_AllocatedResource links each Win32_VideoController
    // (by its DeviceID "VideoControllerN") to Win32_DeviceMemoryAddress
    // ranges (by StartingAddress) — 64-bit ranges handled with
    // [Convert]::ToInt64. rebarActive = any range >= 1 GiB from EITHER
    // source (the A770's only range is 16-20 MB below 4 GB -> ReBAR off,
    // live-verified; no >= 1 GiB window exists anywhere on this machine).
    '$vga = @($vga | ForEach-Object { $id = $_.PNPDeviceID; $res = & pnputil /enum-devices /instanceid $id /resources /format txt 2>$null; $barMax = 0; if ($res) { $res | ForEach-Object { if ($_ -match \'^Memory Resources:\\s*0x([0-9A-Fa-f]+)\\s*-\\s*0x([0-9A-Fa-f]+)\') { $sz = [Convert]::ToInt64($matches[2],16) - [Convert]::ToInt64($matches[1],16) + 1; if ($sz -gt $barMax) { $barMax = $sz } } } }; [pscustomobject]@{ DeviceID = $_.DeviceID; Name = $_.Name; AdapterRAM = $_.AdapterRAM; PNPDeviceID = $id; MaxBarBytes = $barMax } })',
    '$dma = @(Get-CimInstance Win32_DeviceMemoryAddress | Select-Object StartingAddress,EndingAddress)',
    '$alloc = @(Get-CimInstance Win32_AllocatedResource)',
    '$barRes = @(foreach ($v in $vga) { $max = 0; foreach ($r in $alloc) { if ("$($r.Dependent)" -match "Win32_VideoController \\(DeviceID = ""$($v.DeviceID)""\\)" -and "$($r.Antecedent)" -match \'StartingAddress = (\\d+)\') { $start = [Convert]::ToInt64($Matches[1]); $e = @($dma | Where-Object { [Convert]::ToInt64($_.StartingAddress) -eq $start })[0]; if ($e) { $sz = [Convert]::ToInt64($e.EndingAddress) - $start + 1; if ($sz -gt $max) { $max = $sz } } } }; [pscustomobject]@{ PNPDeviceID = $v.PNPDeviceID; MaxBarBytes = $max } })',
    '[pscustomobject]@{ cpu = $cpu; computerSystem = $cs; physicalMemory = $mem; videoControllers = $vga; registryMemory = $regMem; allocatedBar = $barRes } | ConvertTo-Json -Depth 4 -Compress',
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

// ---------------------------------------------------------------------------
// M4-D2 §4: the JEDEC SPD manufacturer-ID -> brand map.
//
// Win32_PhysicalMemory.Manufacturer is the RAW SPD JEDEC code rendered as
// hex (live on this machine: "0420" with PartNumber F3-2400C11-8GXM —
// definitively G.Skill). The codes come from the JEDEC JEP106 table
// (JEP106BN, January 2026 — sourced via RAMSPDToolkit's ManufacturerMapping
// mirror of the JEDEC list, fetched at implementation; the plan's pinned
// codes Kingston "9801" / Samsung "CE00" / SK Hynix "AD00" / Micron "2C00"
// match the [code][continuation-count] rendering of the JEP106 entries).
// FIX-ROUND verification (the RAMSPDToolkit repo is no longer hosted):
// every entry in this map was re-checked against the i2c-tools
// decode-dimms manufacturer table (Jean Delvare, the JEDEC-derived table
// used by the Linux SPD tools) — bank index = continuation count, entry
// index = (code & 0x7F) - 1. All code-first + count-first twins match,
// including '04CD' = bank 5 (count 4), code 0x4D with the DDR3 odd-parity
// bit set (0xCD) = "G Skill Intl" — G.Skill's official JEP106 assignment.
// The live-anchored '0420' (count 4, code 0x20) is what the F3-2400C11
// module family actually programs; the map decodes BOTH the live code and
// the official JEP106 code to G.Skill. Unknown codes pass through honestly
// (never a wrong brand).
// ---------------------------------------------------------------------------

export const JEDEC_BRAND = Object.freeze({
  // Live-verified: F3-2400C11-8GXM (bank 5 code 0x20 under the module's
  // count-first packing — the firmware renders [count][code]).
  '0420': 'G.Skill',
  // Code-first rendering [JEP106 code][continuation count] from the
  // JEP106BN table: Samsung 0xCE/0, SK Hynix 0xAD/0, Micron 0x2C/0,
  // Kingston 0x98/1, Corsair 0x9E/2, ADATA 0xCB/4, Team Group 0xEF/4,
  // Patriot 0x02/5, Crucial 0x9B/5. (All keys quoted — a bare numeric key
  // like 0205 would be an octal literal in strict mode.)
  'CE00': 'Samsung',
  'AD00': 'SK Hynix',
  '2C00': 'Micron',
  '9801': 'Kingston',
  '9E02': 'Corsair',
  'CB04': 'ADATA',
  'EF04': 'Team Group',
  '0205': 'Patriot',
  '9B05': 'Crucial',
  // The count-first packings of the same entries (the G.Skill module
  // proves this packing exists in the wild; both orders are covered).
  '00CE': 'Samsung',
  '00AD': 'SK Hynix',
  '002C': 'Micron',
  '0198': 'Kingston',
  '029E': 'Corsair',
  '04CB': 'ADATA',
  '04EF': 'Team Group',
  '0502': 'Patriot',
  '059B': 'Crucial',
  // G.Skill's OFFICIAL JEP106 assignment in the count-first packing:
  // bank 5 (count 4), code 0x4D + the DDR3 odd-parity bit = 0xCD
  // (verified against the i2c-tools decode-dimms JEDEC-derived table —
  // "G Skill Intl"; the live F3-2400C11 modules program 0x20 instead,
  // hence both keys map to G.Skill).
  '04CD': 'G.Skill',
});

/**
 * Decode a CIM manufacturer value: a 4-hex-digit JEDEC code maps to the
 * brand; anything else (a real brand name, an empty value, a longer
 * string) passes through unchanged — never a wrong claim.
 * @param {unknown} manufacturer
 * @returns {string | null}
 */
export function jedecBrand(manufacturer) {
  if (typeof manufacturer !== 'string' || manufacturer.length === 0) return null;
  const trimmed = manufacturer.trim();
  if (/^[0-9A-Fa-f]{4}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    return JEDEC_BRAND[upper] ?? trimmed;
  }
  return trimmed;
}

/**
 * M4-D2 (user: "read the driver's BAR state"): the DRIVER's Resizable BAR
 * verdict (ctlPciGetProperties.resizable_bar_enabled — the same state IGS +
 * GPU-Z show) is the PRIMARY ReBAR source. Live-verified on this machine:
 * the driver reports enabled=1 while the OS resource map has no large BAR
 * window (Z97 platform) — the tools and the driver agree, the OS window
 * never engaged. The verdict is applied to the FIRST video controller (the
 * primary GPU); a definitive driver verdict (true/false) WINS over the OS
 * resource check; a null driver verdict (unbound symbol / ctl error /
 * no device) keeps the OS verdict unchanged. Pure.
 * @param {object} sysinfo the cached sysinfo shape
 * @param {boolean|null} driverEnabled the driver's resizable_bar_enabled
 * @returns {object} a NEW sysinfo object with the driver verdict merged
 */
export function applyDriverReBar(sysinfo, driverEnabled) {
  if (driverEnabled === null || driverEnabled === undefined || typeof sysinfo !== 'object' || sysinfo === null) {
    return sysinfo;
  }
  if (!Array.isArray(sysinfo.videoControllers) || sysinfo.videoControllers.length === 0) {
    return sysinfo;
  }
  const controllers = sysinfo.videoControllers.map((c, i) => (
    i === 0 ? { ...c, rebarActive: driverEnabled } : c
  ));
  return { ...sysinfo, videoControllers: controllers };
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
 * M4-D2 (§3): merge the allocated-resource cross-check rows into the
 * controller list — per controller, the ReBAR verdict comes from the LARGER
 * of the two sources (pnputil per-device resources and the
 * Win32_AllocatedResource -> Win32_DeviceMemoryAddress join), matched by
 * PNPDeviceID. rebarActive = any range >= 1 GiB from either source.
 * @param {Array<{ pnpDeviceId: string|null, rebarActive: boolean|null }>} controllers
 * @param {Array<{ PNPDeviceID?: unknown, MaxBarBytes?: unknown }>} allocatedBar
 *   the raw parsed cross-check rows
 */
export function applyAllocatedBar(controllers, allocatedBar) {
  const rows = Array.isArray(allocatedBar) ? allocatedBar : [];
  return controllers.map((c) => {
    if (!c.pnpDeviceId) return c;
    const row = rows.find((r) => typeof r?.PNPDeviceID === 'string' && r.PNPDeviceID === c.pnpDeviceId);
    const crossBytes = typeof row?.MaxBarBytes === 'number' && Number.isFinite(row.MaxBarBytes) ? row.MaxBarBytes : 0;
    const pnputilBytes = typeof c._pnputilBarBytes === 'number' && Number.isFinite(c._pnputilBarBytes) ? c._pnputilBarBytes : 0;
    return {
      ...c,
      rebarActive: rebarFromMaxBarBytes(Math.max(pnputilBytes, crossBytes)),
    };
  });
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
    // M4-H: the cache sizes (KB; the Caches row renders only the levels
    // that exist). CIM has NO L4 field — l4CacheKb is never set here.
    l1CacheKb: num(cpuRaw?.L1CacheSize),
    l2CacheKb: num(cpuRaw?.L2CacheSize),
    l3CacheKb: num(cpuRaw?.L3CacheSize),
  };
  const ram = {
    totalBytes: num(csRaw?.TotalPhysicalMemory) ?? 0,
    speedMhz: num(memRaw?.ConfiguredClockSpeed),
    // M4-D2: the raw SPD JEDEC code ("0420") decodes to the brand
    // (G.Skill); a real name / unknown code passes through honestly.
    manufacturer: jedecBrand(memRaw?.Manufacturer),
    // M4-H: the SMBIOS Type-17 memory-type code (24=DDR3, 34=DDR5, ... —
    // the pure ramMemoryType mapping in the renderer derives the label).
    memoryType: num(memRaw?.SMBIOSMemoryType),
  };
  const controllers = applyAllocatedBar(
    applyRegistryMemory(
      vgaRaw
        .map((c) => ({
          name: typeof c?.Name === 'string' ? c.Name : null,
          vramBytes: vramBytesFromAdapterRam(c?.AdapterRAM),
          pnpDeviceId: typeof c?.PNPDeviceID === 'string' && c.PNPDeviceID ? c.PNPDeviceID : null,
          rebarActive: null,
          // M4-D2: the pnputil source rides along (merged with the
          // allocated-resource cross-check by applyAllocatedBar).
          _pnputilBarBytes: typeof c?.MaxBarBytes === 'number' && Number.isFinite(c.MaxBarBytes) ? c.MaxBarBytes : 0,
        }))
        .filter((c) => c.name !== null),
      raw?.registryMemory,
    ),
    raw?.allocatedBar,
  );
  // M4-D2: the internal pnputil byte count never surfaces (only the merged
  // verdict does).
  const videoControllers = controllers.map(({ _pnputilBarBytes, ...rest }) => rest);
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
    ? { name: cpus[0].model, cores: null, threads: cpus.length, maxClockMhz: cpus[0].speed, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null }
    : { name: null, cores: null, threads: null, maxClockMhz: null, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null };
  return {
    cpu,
    ram: { totalBytes: os.totalmem(), speedMhz: null, manufacturer: null, memoryType: null },
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
          l1CacheKb: parsed.cpu.l1CacheKb ?? null,
          l2CacheKb: parsed.cpu.l2CacheKb ?? null,
          l3CacheKb: parsed.cpu.l3CacheKb ?? null,
        },
        ram: {
          totalBytes: parsed.ram?.totalBytes || os.totalmem(),
          speedMhz: parsed.ram?.speedMhz ?? null,
          manufacturer: parsed.ram?.manufacturer ?? null,
          memoryType: parsed.ram?.memoryType ?? null,
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
 * 1.0.1 no-Intel round: RID_MOCK_NO_INTEL=1 switches the fixture's video
 * controller to an AMD part ('AMD Radeon RX 7600'-style with vramBytes + a
 * pnpDeviceId + rebarActive false) — the no-Intel machine shape the
 * renderer's osGpu / header / GPU card read.
 * M4-H: the fixture gains SMBIOSMemoryType 34 (DDR5 — the Memory-row type
 * label) + L1/L2/L3/L4 cache sizes (L4 has NO OS source — the fixture
 * carries it so the Caches row renders in verify; real hardware shows what
 * CIM reports).
 * @param {{ cpu?: object, ram?: object, videoControllers?: object[] }} [overrides]
 */
export function createMockSysinfo(overrides = {}) {
  const noIntel = process.env.RID_MOCK_NO_INTEL === '1';
  return {
    get: async () => ({
      cpu: {
        name: 'Intel(R) Core(TM) i7-14700K',
        cores: 20,
        threads: 28,
        maxClockMhz: 5600,
        // M4-H: the cache sizes (KB) — the Caches row renders them as
        // "L1 1.4 MB / L2 36.0 MB / L3 672.0 MB / L4 384.0 MB".
        l1CacheKb: 1470,
        l2CacheKb: 36864,
        l3CacheKb: 688128,
        l4CacheKb: 393216,
        ...(overrides.cpu ?? {}),
      },
      ram: {
        totalBytes: 34359738368, // 32 GiB
        speedMhz: 6000,
        manufacturer: 'G.Skill',
        memoryType: 34, // DDR5 (SMBIOS Type-17)
        ...(overrides.ram ?? {}),
      },
      videoControllers: noIntel ? [
        {
          name: 'AMD Radeon RX 7600',
          vramBytes: 8589934592, // 8 GiB
          pnpDeviceId: 'PCI\\VEN_1002&DEV_7480&SUBSYS_24011462&REV_C7',
          rebarActive: false,
        },
        ...(overrides.videoControllers ?? []),
      ] : [
        {
          name: 'Intel(R) Arc(TM) A770 Graphics',
          vramBytes: 17179869184, // 16 GiB (the 16 GB config)
          pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08',
          rebarActive: true,
        },
        ...(overrides.videoControllers ?? []),
      ],
    }),
  };
}
