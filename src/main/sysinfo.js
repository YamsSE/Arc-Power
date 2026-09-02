// Arc Power - M4-D system-info module (electron-free).
//
// One PowerShell CIM query per session, cached at boot (the dashboard CPU
// card + the VRAM enrichment both read this). Shape:
//   {
//     cpu: { name, cores, threads, maxClockMhz, manufacturer }, // Win32_Processor
//     ram: { totalBytes, speedMhz|null },                  // Win32_ComputerSystem
//                                                          // + Win32_PhysicalMemory
//     videoControllers: [{ name, vramBytes|null, pnpDeviceId|null }],  // Win32_VideoController
//   }
// Fallback: when PowerShell fails/absents (non-Windows CI, sandbox, spawn
// error) the query degrades to os.cpus() + os.totalmem() - CPU name/threads/
// clock stay populated, RAM speed + video controllers degrade honestly to
// null/empty. os.cpus() cannot distinguish physical from logical cores, so
// `cores` degrades to null (never an estimate).
//
// VRAM: AdapterRAM is a 32-bit field - a >4 GB card saturates it to
// 0xFFFFFFFF / the ~2 GiB plateau (0x7FFFFFF0 - live-verified on the A770),
// so suspicious values degrade to null. The RELIABLE source is the display
// class registry subkey's `HardwareInformation.qwMemorySize` (UInt64 bytes,
// matched to the controller by PNPDeviceID prefix) - it wins over AdapterRAM
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
 * L3CacheSize - KB, the Caches row source), Win32_ComputerSystem
 * (TotalPhysicalMemory), Win32_PhysicalMemory (Manufacturer/
 * ConfiguredClockSpeed/SMBIOSMemoryType - the RAM brand for the bundled
 * memory row; the Manufacturer is the raw SPD JEDEC hex code, decoded by
 * jedecBrand in the parse; SMBIOSMemoryType is the Type-17 code the
 * dashboard's DDR5-style label derives from), Win32_VideoController
 *  (Name/AdapterRAM/PNPDeviceID), the display
 *  class registry subkeys' HardwareInformation.qwMemorySize (UInt64 bytes,
 *  keyed by MatchingDeviceId). M17p: the OS ReBAR sources are LIGHTENED -
 *  the per-controller pnputil resource spawn and the
 *  Win32_DeviceMemoryAddress/Win32_AllocatedResource cross-check are
 *  REMOVED from the query (the measured expensive tail of the ~3.1-s
 *  query). The DRIVER's BAR verdict (ctlPciGetProperties, main.js
 *  driverReBar) is the documented PRIMARY ReBAR source and now decides
 *  alone; the OS sources were only the fallback for a null driver verdict
 *  (that verdict now degrades to null - the renderer's grey pill). The
 *  JSON shape stays byte-identical: the controller rows still emit
 *  MaxBarBytes (always 0) and the payload still carries allocatedBar
 *  (always []) - the parse side is untouched.
 *  M4-D2: the PCIe-link property queries are REMOVED (the row was removed -
 *  the unpopulated 1/1 pattern made it a permanent '-' on this machine).
 *  Serialized to JSON by PowerShell itself (the parse side stays dumb). A
 *  missing class on a stripped-down system serializes as null/[] - the
 *  parser degrades those honestly.
 * @returns {string}
 */
export function buildSysinfoScript() {
  return [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,Manufacturer',
    // M17c: the computerSystem query gains Manufacturer/Model/PCSystemType
    // (the laptop-branch AIB source - the Win32_ComputerSystem fields the
    // mobile-board decode keys on; PCSystemType 2 = the portable code).
    '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 TotalPhysicalMemory,Manufacturer,Model,PCSystemType',
    // M17c: the chassis query - Win32_SystemEnclosure ChassisTypes (the
    // SECOND portable-form-factor signal: the chassis codes 8/9/10/14/30/
    // 31/32 - the pinned rule lives in pure/aib.ts).
    '$enc = Get-CimInstance Win32_SystemEnclosure | Select-Object -First 1 ChassisTypes',
    // M4-H: the memory row also reads SMBIOSMemoryType (the Type-17 code -
    // 24 = DDR3, 34 = DDR5 on the mock; the parse maps it, anything unknown
    // is omitted).
    // M17b: PartNumber joins the query (the ramBrandOf fallback source -
    // a Juhor part number resolves the brand when the JEDEC decode yields
    // nothing usable, e.g. the BIOS writing the literal string "Unknown").
    '$mem = Get-CimInstance Win32_PhysicalMemory | Select-Object -First 1 Manufacturer,ConfiguredClockSpeed,SMBIOSMemoryType,PartNumber',
    // M4J (B): the Mainboard row source - Win32_BaseBoard Manufacturer +
    // Product (the M4-I Win32_CacheMemory query is REMOVED with the Cache
    // row; the baseboard replaces it).
    '$bb = Get-CimInstance Win32_BaseBoard | Select-Object -First 1 Manufacturer,Product',
    // M4-I: the video controllers also carry DriverVersion (the no-Intel
    // device card's Driver version row - works on ANY GPU).
    '$vga = @(Get-CimInstance Win32_VideoController | Select-Object DeviceID,Name,AdapterRAM,PNPDeviceID,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution)',
    // M30: bridge OS PNP rows to the stable PCI BDF exposed by NVML/ADL.
    // LocationInfo is optional; an unavailable PnP cmdlet/property simply
    // leaves the identity bridge absent and telemetry fails closed.
    '$pnpLocations = @{}',
    '@(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | ForEach-Object { $loc = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_LocationInfo -ErrorAction SilentlyContinue).Data; if ($loc) { $pnpLocations[$_.InstanceId] = $loc } }) | Out-Null',
    '$regMem = @(Get-ChildItem \'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.\'HardwareInformation.qwMemorySize\' -and $p.MatchingDeviceId) { [pscustomobject]@{ PNPDeviceID = $p.MatchingDeviceId; MemoryBytes = $p.\'HardwareInformation.qwMemorySize\' } } })',
    // M17p: the OS ReBAR sources are LIGHTENED (the measured expensive
    // tail: the per-controller pnputil subprocess spawn - one per video
    // controller inside the PS session - plus the
    // Win32_DeviceMemoryAddress/Win32_AllocatedResource cross-check, the
    // two CIM queries + the join measuring ~1.5 s of the ~3.1-s query on
    // this box). The DRIVER's BAR verdict (ctlPciGetProperties - the
    // documented PRIMARY source, main.js driverReBar) now decides ReBAR
    // alone; the OS sources were only the fallback for a null driver
    // verdict - that verdict now degrades to null (the renderer's grey
    // pill). The JSON shape stays byte-identical: the controller rows
    // still emit MaxBarBytes (always 0) and the payload still carries
    // allocatedBar (always []) - the parse side is untouched (a
    // functioning multi-GiB OS window can no longer flip the verdict).
    '$vga = @($vga | ForEach-Object { [pscustomobject]@{ DeviceID = $_.DeviceID; Name = $_.Name; AdapterRAM = $_.AdapterRAM; PNPDeviceID = $_.PNPDeviceID; DriverVersion = $_.DriverVersion; CurrentHorizontalResolution = $_.CurrentHorizontalResolution; CurrentVerticalResolution = $_.CurrentVerticalResolution; LocationInfo = $pnpLocations[$_.PNPDeviceID]; MaxBarBytes = 0 } })',
    '$barRes = @()',
    '[pscustomobject]@{ cpu = $cpu; computerSystem = $cs; systemEnclosure = $enc; physicalMemory = $mem; baseboard = $bb; videoControllers = $vga; registryMemory = $regMem; allocatedBar = $barRes } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ');
}

/**
 * M7b (fix 1): the REAL-GPU vendor predicate - keeps a controller only when
 * it is an AMD / Intel / NVIDIA part. Win32_VideoController can list
 * non-GPU devices ("Microsoft Basic Display Adapter", DisplayLink docks,
 * virtual/remote adapters); a non-GPU at index 0 would win the dashboard /
 * health fallbacks (videoControllers[0]) and show as the GPU. The predicate:
 *   - pnpDeviceId matches /VEN_(8086|1002|10DE)/i (Intel / AMD / NVIDIA PCI
 *     vendor ids), OR
 *   - the name matches /intel|nvidia|radeon|geforce|arc|ati/i
 *     (case-insensitive - "Intel(R) Arc(TM) A770 Graphics" etc.),
 * AND the name is NEVER basic|microsoft (the belt-and-braces exclusion - a
 * "Microsoft Remote Display Adapter" must not pass on its VEN_8086 pnp id).
 * NO CIM Manufacturer change: the predicate keys on pnpDeviceId + name, and
 * a generically-named controller with a null pnpDeviceId is never a real
 * GPU. Applied at the SOURCE (the parse + the mock fixture - the fixture
 * path bypasses the parse) so the payload only ever carries real GPUs.
 * @param {object | null | undefined} c
 * @returns {boolean}
 */
export function isRealGpuController(c) {
  if (!c || typeof c !== 'object') return false;
  const name = typeof c.name === 'string' ? c.name : '';
  // NEVER basic|microsoft by name - the belt-and-braces exclusion (a
  // vendor-matching pnpDeviceId on a Microsoft fallback adapter must not
  // slip a non-GPU through).
  // Vendor words also occur on virtual, remote, mirror and USB display
  // adapters.  They are not physical GPU rows and must never receive a
  // registry VRAM correction merely because their name contains NVIDIA,
  // AMD, Intel or Radeon.
  if (/basic|microsoft|virtual|remote|displaylink|indirect|mirror/i.test(name)) return false;
  const pnp = typeof c.pnpDeviceId === 'string' ? c.pnpDeviceId : '';
  return /VEN_(8086|1002|10DE)/i.test(pnp) || /intel|nvidia|radeon|geforce|arc|ati/i.test(name);
}

/**
 * M4-D: AdapterRAM -> vramBytes (the FALLBACK source). AdapterRAM is a
 * 32-bit field whose saturation sentinels carry no byte count: 0xFFFFFFFF
 * (>4 GB cards saturate to it), 0x7FFFFFFF and 0x80000000 (common
 * "unknown" values), the ~2 GiB plateau (0x7FFFFFF0 family - live-verified
 * on the A770, which is really 16 GiB), and 0 / negative / non-finite.
 * Those degrade to null so the UI never prints a wrong VRAM figure. Any
 * other positive value is a trustworthy byte count for a genuinely small
 * adapter (the real CIM field is a UInt32, so values above 0xFFFFFFFF can
 * only come from fixtures - still honest).
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
 * ("PCI\VEN_8086&DEV_56A0&SUBSYS_...") - matched to a controller by
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
    const controllerId = normalizeIdentity(c.pnpDeviceId);
    const candidates = rows.filter((r) => {
      const devId = typeof r?.PNPDeviceID === 'string' ? r.PNPDeviceID : '';
      const mem = r?.MemoryBytes;
      const normalizedId = normalizeIdentity(devId);
      return controllerId && normalizedId
        && normalizedId.length > 0
        && typeof mem === 'number' && Number.isFinite(mem) && mem > 0
        && (normalizedId === controllerId || controllerId.startsWith(normalizedId));
    });
    // Prefer the most specific match.  An exact match must still be unique;
    // duplicate or equally-specific registry rows are ambiguous and must not
    // attach an arbitrary VRAM value.
    const exact = candidates.filter((r) => normalizeIdentity(r.PNPDeviceID) === controllerId);
    const specific = exact.length > 0
      ? exact
      : candidates.filter((r) => normalizeIdentity(r.PNPDeviceID).length === Math.max(...candidates.map((row) => normalizeIdentity(row.PNPDeviceID).length)));
    const row = specific.length === 1 ? specific[0] : null;
    // The registry UInt64 is the RELIABLE source - it wins over the
    // 32-bit AdapterRAM whenever it exists. Normalize the known generic
    // one-GiB under-report signatures before the value reaches every
    // backend/device-name consumer.
    return row
      ? { ...c, vramBytes: normalizeRegistryMemory(c, Math.floor(row.MemoryBytes)) }
      : c;
  });
}
/**
 * Normalize the known Windows display-driver under-report shapes for any
 * real PCI GPU. Some drivers expose an 8/16-GiB board through the registry as
 * exactly 7/15 GiB while AdapterRAM is saturated or otherwise unusable. Keep
 * this deliberately narrow: arbitrary values are not rounded or guessed,
 * and non-GPU display rows are left untouched.
 * @param {object} controller
 * @param {number} memoryBytes
 * @returns {number}
 */
export function normalizeRegistryMemory(controller, memoryBytes) {
  if (!controller || typeof controller !== 'object') return memoryBytes;
  if (!isRealGpuController(controller)) return memoryBytes;
  const correction = new Map([
    [7 * 1024 ** 3, 8 * 1024 ** 3],
    [15 * 1024 ** 3, 16 * 1024 ** 3],
  ]);
  if (correction.has(memoryBytes)) return correction.get(memoryBytes);
  return memoryBytes;
}

// ---------------------------------------------------------------------------
// M4-D2 §4: the JEDEC SPD manufacturer-ID -> brand map.
//
// Win32_PhysicalMemory.Manufacturer is the RAW SPD JEDEC code rendered as
// hex (live on this machine: "0420" with PartNumber F3-2400C11-8GXM -
// definitively G.Skill). The codes come from the JEDEC JEP106 table.
//
// M15: the map is rebuilt from the memtest86plus system/jedec_id.h mirror
// of the JEP106-BA (January 2022) manufacturer list - every ENABLED
// ENTRY(0xNNNN, "Name") line (the memory-relevant subset; comment-out
// noise ignored), PLUS six entries beyond memtest's enabled set (Dell
// '0CFD', Espressif '0C92', LDLC '0C97', Star Memory '0CE3', Dahua '0BF7',
// Xllbyte '0FB3') - all verified REAL in the current JEP106BO list (openocd
// mirror, May 2026), added for exhaustive coverage per the plan's spirit.
// ENTRY value = [bank][code]: bank = continuation count,
// code = the RAW 7-bit JEP106 code (parity is applied at decode time by
// the tools, NOT stored). The table keys keep the app's existing
// parity-carrying convention (e.g. Samsung 0x4E -> 'CE00': bit 7 set when
// the popcount of the raw code byte is EVEN - odd parity; verified
// consistent with all 10 original keys). Per entry:
//   code8 = popcount(code) % 2 === 0 ? code | 0x80 : code
// keyed BOTH as [count][code8] and [code8][count].
//
// Juhor IS a registered JEDEC manufacturer - JEP106 bank 8, code 0x75
// (popcount 5 odd, so the parity bit stays 0), which Windows renders as
// "0875". Three independent mirrors agree: openocd src/helper/jep106.inc
// [8][0x75-1] = "JUHOR", memtest86plus system/jedec_id.h ENTRY(0x0875,
// "JUHOR"), tianocore edk2 JedecJep106Lib.c { 0x75, "JUHOR" }. The 0x0A7D
// entry ("ShenZhen Juhor Precision Tech Co Ltd") is a DIFFERENT company -
// mapped under its full legal name, never 'Juhor'. SOURCE-VERSION DRIFT
// NOTE: the declared memtest86plus jedec_id.h (JEP106-BA, Jan 2022) shows
// plain "Juhor" for the 0x0A7D entry, while the current JEP106BO list
// (openocd, May 2026) carries the full legal name 'ShenZhen Juhor Precision
// Tech Co Ltd'; the mapping uses the CURRENT legal name and must NOT be
// "corrected" back to the older list's short form.
//
// The live-anchored '0420' (count 4, code 0x20) is what the F3-2400C11
// module family actually programs; the map decodes BOTH the live code and
// the official JEP106 code ('04CD', bank 4 code 0x4D + the odd-parity bit)
// to G.Skill. Unknown codes pass through honestly (never a wrong brand).
// ---------------------------------------------------------------------------

export const JEDEC_BRAND = Object.freeze({
  // Live-verified: F3-2400C11-8GXM (the module programs 0x20 under the
  // count-first packing - the firmware renders [count][code]); the twin
  // '2004' is the code-first rendering of the same live code.
  '0420': 'G.Skill',
  '2004': 'G.Skill',
  // JEP106 bank 0 (continuation count 00):
  '0001': 'AMD', '0100': 'AMD',
  '0004': 'Fujitsu', '0400': 'Fujitsu',
  '0085': 'GTE', '8500': 'GTE',
  '0089': 'Intel', '8900': 'Intel',
  '000E': 'Freescale', '0E00': 'Freescale',
  '0010': 'NEC', '1000': 'NEC',
  '0097': 'Texas Instruments', '9700': 'Texas Instruments',
  '0098': 'Kioxia (Toshiba)', '9800': 'Kioxia (Toshiba)',
  '0020': 'STMicro.', '2000': 'STMicro.',
  '00A4': 'IBM', 'A400': 'IBM',
  '0029': 'Microchip', '2900': 'Microchip',
  '002C': 'Micron', '2C00': 'Micron',
  '00AD': 'SK Hynix', 'AD00': 'SK Hynix',
  '0040': 'MOSEL', '4000': 'MOSEL',
  '00C1': 'Infineon', 'C100': 'Infineon',
  '00C2': 'Macronix', 'C200': 'Macronix',
  '00C8': 'Apple', 'C800': 'Apple',
  '00CE': 'Samsung', 'CE00': 'Samsung',
  '00DA': 'Winbond', 'DA00': 'Winbond',
  '00E0': 'LG', 'E000': 'LG',
  '0062': 'Sanyo', '6200': 'Sanyo',
  // JEP106 bank 1 (continuation count 01):
  '0194': 'Smart Modular', '9401': 'Smart Modular',
  '0198': 'Kingston', '9801': 'Kingston',
  '0132': 'Mushkin', '3201': 'Mushkin',
  '01BA': 'PNY', 'BA01': 'PNY',
  '0140': 'Viking', '4001': 'Viking',
  '01C2': 'Flextronics', 'C201': 'Flextronics',
  '0145': 'Micron CMS', '4501': 'Micron CMS',
  '014F': 'Transcend', '4F01': 'Transcend',
  '01DA': 'Dane-Elec', 'DA01': 'Dane-Elec',
  '0161': 'Wintec', '6101': 'Wintec',
  '0179': 'Acbel', '7901': 'Acbel',
  '017A': 'Apacer', '7A01': 'Apacer',
  '017C': 'FOXCONN', '7C01': 'FOXCONN',
  // JEP106 bank 2 (continuation count 02):
  '029E': 'Corsair', '9E02': 'Corsair',
  '022A': 'Kentron', '2A02': 'Kentron',
  '022F': 'Siemens AG', '2F02': 'Siemens AG',
  '02B5': 'SpecTek', 'B502': 'SpecTek',
  '02FE': 'Elpida', 'FE02': 'Elpida',
  // JEP106 bank 3 (continuation count 03):
  '030B': 'Nanya', '0B03': 'Nanya',
  '038F': 'ATI', '8F03': 'ATI',
  '0313': 'GEIL', '1303': 'GEIL',
  '0394': 'Mushkin', '9403': 'Mushkin',
  '0316': 'Netlist', '1603': 'Netlist',
  '0325': 'Kingmax', '2503': 'Kingmax',
  '0334': 'Tekmos', '3403': 'Tekmos',
  '03D6': 'Jade Star', 'D603': 'Jade Star',
  '0358': 'takeMS', '5803': 'takeMS',
  '03DA': 'Swissbit', 'DA03': 'Swissbit',
  '036B': 'NVIDIA', '6B03': 'NVIDIA',
  '0379': 'Utron', '7903': 'Utron',
  // JEP106 bank 4 (continuation count 04):
  '0416': 'Positivo', '1604': 'Positivo',
  '0426': 'MediaTek', '2604': 'MediaTek',
  '04B0': 'OCZ', 'B004': 'OCZ',
  '0443': 'Ramaxel', '4304': 'Ramaxel',
  '044A': 'Excel', '4A04': 'Excel',
  // 'ADATA' keeps the app's established display rendering (the JEP106
  // registration name is "A-DATA").
  '04CB': 'ADATA', 'CB04': 'ADATA',
  // G.Skill's official JEP106 assignment: bank 4, code 0x4D + the
  // odd-parity bit = 0xCD (verified against the i2c-tools decode-dimms
  // JEDEC-derived table - "G Skill Intl"; the live F3-2400C11 modules
  // program 0x20 instead, hence both code pairs map to G.Skill).
  '04CD': 'G.Skill', 'CD04': 'G.Skill',
  '04CE': 'Quanta', 'CE04': 'Quanta',
  '04D5': 'Microsoft', 'D504': 'Microsoft',
  '04D6': 'Open-Silicon', 'D604': 'Open-Silicon',
  '0467': 'Gigaram', '6704': 'Gigaram',
  '04EF': 'Team Group', 'EF04': 'Team Group',
  '04F1': 'Toshiba', 'F104': 'Toshiba',
  '0476': 'Thomson SC', '7604': 'Thomson SC',
  // JEP106 bank 5 (continuation count 05):
  '0502': 'Patriot', '0205': 'Patriot',
  '0586': 'CompuRAM', '8605': 'CompuRAM',
  '0510': 'Gigaram', '1005': 'Gigaram',
  '0597': 'COS Memory', '9705': 'COS Memory',
  '059B': 'Crucial', '9B05': 'Crucial',
  '05AB': 'Acbel', 'AB05': 'Acbel',
  '053E': 'PQI', '3E05': 'PQI',
  '0546': 'MSI', '4605': 'MSI',
  '0551': 'Qimonda', '5105': 'Qimonda',
  '05D6': 'Chaintech', 'D605': 'Chaintech',
  '0557': 'AENEON', '5705': 'AENEON',
  '05DC': 'Hexon', 'DC05': 'Hexon',
  '0562': 'Goldenmars', '6205': 'Goldenmars',
  '05E3': 'Kreton', 'E305': 'Kreton',
  '0567': 'Spansion', '6705': 'Spansion',
  '05F7': 'Avant', 'F705': 'Avant',
  '05F8': 'Asrock', 'F805': 'Asrock',
  // JEP106 bank 6 (continuation count 06):
  '0616': 'Avexir', '1606': 'Avexir',
  '069D': 'Rambus', '9D06': 'Rambus',
  '0634': 'Super Talent', '3406': 'Super Talent',
  '06C1': 'ASint', 'C106': 'ASint',
  '06C2': 'Ramtron', 'C206': 'Ramtron',
  '06C8': 'GigaDevice', 'C806': 'GigaDevice',
  '06CB': 'Northrop Grumman', 'CB06': 'Northrop Grumman',
  '0651': 'Kinglife', '5106': 'Kinglife',
  '06D3': 'Silicon Power', 'D306': 'Silicon Power',
  '065D': 'SandForce', '5D06': 'SandForce',
  '065E': 'Lexar Media', '5E06': 'Lexar Media',
  '0661': 'Smartek', '6106': 'Smartek',
  '06E9': 'SanMax', 'E906': 'SanMax',
  '066B': 'TwinMOS', '6B06': 'TwinMOS',
  '06F1': 'InnoDisk', 'F106': 'InnoDisk',
  // JEP106 bank 7 (continuation count 07):
  '0783': 'Strontium', '8307': 'Strontium',
  '0710': 'King Tiger', '1007': 'King Tiger',
  '0725': 'Ramos', '2507': 'Ramos',
  '07AE': 'Topower', 'AE07': 'Topower',
  '0732': 'Ritek', '3207': 'Ritek',
  '075D': 'Wilk Elektronik', '5D07': 'Wilk Elektronik',
  '07E3': 'OCMEMORY', 'E307': 'OCMEMORY',
  '0768': 'KingboMars', '6807': 'KingboMars',
  '07EA': 'Transcend', 'EA07': 'Transcend',
  '07EF': 'Zentel', 'EF07': 'Zentel',
  '07F2': 'LITE-ON', 'F207': 'LITE-ON',
  // JEP106 bank 8 (continuation count 08):
  '0892': 'Galaxy', '9208': 'Galaxy',
  '0813': 'Gloway', '1308': 'Gloway',
  '0898': 'KLEVV', '9808': 'KLEVV',
  '0826': 'Google', '2608': 'Google',
  '082A': 'Keysight', '2A08': 'Keysight',
  '08B3': 'Memorysolution', 'B308': 'Memorysolution',
  '08BC': 'Cuso', 'BC08': 'Cuso',
  '083D': 'Kuso', '3D08': 'Kuso',
  '08C8': 'Lenovo', 'C808': 'Lenovo',
  '08D0': 'Heoriady', 'D008': 'Heoriady',
  '0858': 'HGST', '5808': 'HGST',
  '08D9': 'EVGA', 'D908': 'EVGA',
  '085D': 'Foxtronn', '5D08': 'Foxtronn',
  '08F1': 'Asgard', 'F108': 'Asgard',
  // Juhor: JEP106 bank 8, code 0x75 (the memtest86plus JUHOR entry; the
  // Windows [count][code] rendering is "0875" - see the section comment
  // for the three-mirror verification).
  '0875': 'Juhor', '7508': 'Juhor',
  '0879': 'Realtek', '7908': 'Realtek',
  // JEP106 bank 9 (continuation count 09):
  '0902': 'VMware', '0209': 'VMware',
  '0983': 'HPE', '8309': 'HPE',
  '099B': 'YMTC', '9B09': 'YMTC',
  '099E': 'Allwinner', '9E09': 'Allwinner',
  '09A2': 'Maxsun', 'A209': 'Maxsun',
  '09A4': 'RamCENTER', 'A409': 'RamCENTER',
  '09C2': 'Kllisre', 'C209': 'Kllisre',
  '09EC': 'Colorful', 'EC09': 'Colorful',
  '09F2': 'GIGABYTE', 'F209': 'GIGABYTE',
  '09F7': 'Netac', 'F709': 'Netac',
  '09F8': 'PCCOOLER', 'F809': 'PCCOOLER',
  // JEP106 bank 10 (continuation count 0A):
  '0A02': 'KingSpec', '020A': 'KingSpec',
  '0A91': 'CXMT', '910A': 'CXMT',
  '0AAD': 'PUSKILL', 'AD0A': 'PUSKILL',
  '0A31': 'Biwin', '310A': 'Biwin',
  '0AC2': 'Thermaltake', 'C20A': 'Thermaltake',
  '0A45': 'Chun Well', '450A': 'Chun Well',
  '0AD5': 'Facebook', 'D50A': 'Facebook',
  '0A5D': 'SKIHOTAR', '5D0A': 'SKIHOTAR',
  '0AE9': 'Fraunhofer IIS', 'E90A': 'Fraunhofer IIS',
  '0A6B': 'Acer', '6B0A': 'Acer',
  '0A76': 'Lexar', '760A': 'Lexar',
  // The OTHER Juhor: bank 10 code 0x7D is "ShenZhen Juhor Precision Tech
  // Co Ltd" - a different company from the bank-8 RAM brand; mapped under
  // its full legal name, never 'Juhor'.
  '0AFD': 'ShenZhen Juhor Precision Tech Co Ltd', 'FD0A': 'ShenZhen Juhor Precision Tech Co Ltd',
  // JEP106 bank 11 (continuation count 0B):
  '0B92': 'Kingbank', '920B': 'Kingbank',
  '0B19': 'Allegro', '190B': 'Allegro',
  '0B2C': 'Hikstorage', '2C0B': 'Hikstorage',
  '0B58': 'SOYO', '580B': 'SOYO',
  '0BDC': 'ASUS', 'DC0B': 'ASUS',
  '0BF7': 'Dahua', 'F70B': 'Dahua',
  // JEP106 bank 12 (continuation count 0C):
  '0C10': 'Reliance Memory', '100C': 'Reliance Memory',
  '0C92': 'Espressif', '920C': 'Espressif',
  '0C97': 'LDLC', '970C': 'LDLC',
  '0C26': 'Timetec', '260C': 'Timetec',
  '0C34': 'Amazon', '340C': 'Amazon',
  '0C57': 'ROG', '570C': 'ROG',
  '0C5D': 'OLOy', '5D0C': 'OLOy',
  '0C61': 'Rochester', '610C': 'Rochester',
  '0CE3': 'Star Memory', 'E30C': 'Star Memory',
  '0C64': 'Agile Memory', '640C': 'Agile Memory',
  '0C7A': 'Zhaoxin', '7A0C': 'Zhaoxin',
  '0C7C': 'Hikstorage', '7C0C': 'Hikstorage',
  '0CFD': 'Dell', 'FD0C': 'Dell',
  // JEP106 bank 13 (continuation count 0D):
  '0D61': 'Lyczar', '610D': 'Lyczar',
  // JEP106 bank 14 (continuation count 0E):
  '0E51': 'Xiaoli AI', '510E': 'Xiaoli AI',
  '0E58': 'Trium Elek.', '580E': 'Trium Elek.',
  // JEP106 bank 15 (continuation count 0F):
  '0FB3': 'Xllbyte', 'B30F': 'Xllbyte',
  '0F37': 'SSTC', '370F': 'SSTC',
});

/**
 * The JEP106 parity-carrying code byte: bit 7 is set when the popcount of
 * the raw 7-bit code is even (odd parity), cleared otherwise. This is the
 * exact convention the JEDEC_BRAND keys are built with.
 * @param {number} raw the raw code byte (bit 7 ignored)
 * @returns {number} the parity-carrying byte
 */
function jedecCode8(raw) {
  const code = raw & 0x7f;
  let bits = code;
  let popcount = 0;
  while (bits > 0) {
    popcount += bits & 1;
    bits >>= 1;
  }
  return popcount % 2 === 0 ? code | 0x80 : code;
}

/** The parity-carrying rendering of a 2-hex byte ('4E' -> 'CE'). */
function jedecCode8Hex(hex2) {
  return jedecCode8(parseInt(hex2, 16)).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * M17b: resolve one zero-padded [count][code] pair through the map - every
 * packing + the parity-fixed lookups, bounded (six tries total):
 *   XY, YX                    - the two direct packings (both carry the
 *                               stored code byte);
 *   XY', Y'X                  - the parity-normalized CODE byte (the
 *                               count-first raw DDR4/DDR5 rendering);
 *   X'Y, YX'                  - the parity-normalized CODE byte in the
 *                               FIRST position too (the code-first raw
 *                               rendering - the M17b x-side fix).
 * Candidates resolve ONLY through the existing map keys; a miss returns
 * undefined (the caller passes the input through unchanged).
 * @param {string} countHex2 zero-padded 2-hex count byte
 * @param {string} codeHex2 zero-padded 2-hex code byte
 * @returns {string | undefined}
 */
function resolveJedecPair(countHex2, codeHex2) {
  const tries = [
    countHex2 + codeHex2,
    codeHex2 + countHex2,
    countHex2 + jedecCode8Hex(codeHex2),
    jedecCode8Hex(codeHex2) + countHex2,
    jedecCode8Hex(countHex2) + codeHex2,
    codeHex2 + jedecCode8Hex(countHex2),
  ];
  for (const key of tries) {
    if (key in JEDEC_BRAND) return JEDEC_BRAND[key];
  }
  return undefined;
}

/**
 * M17b: the bounded candidate search for a 3-5 hex digit code - every
 * [count][code] / [code][count] split with 1-2 digits per half (zero-
 * padded), resolved through resolveJedecPair (parity on the code half in
 * both positions). A 5-digit string cannot split into two 1-2-digit
 * halves, so no candidates exist for it - the caller's zero-drop re-run
 * (00875 -> 0875) is the only 5-digit path.
 * @param {string} stripped the 0x-stripped code (3-5 hex digits)
 * @returns {string | undefined}
 */
function searchJedecCandidates(stripped) {
  const upper = stripped.toUpperCase();
  // The 1-2-digit-per-half splits: [1][2] and [2][1] (a 3-digit value; a
  // 4-digit value rides the fast path, a 5-digit value has no valid split).
  const halves = [
    [upper.slice(0, 1), upper.slice(1)],
    [upper.slice(0, 2), upper.slice(2)],
  ];
  for (const [a, b] of halves) {
    if (a.length === 0 || b.length === 0 || a.length > 2 || b.length > 2) continue;
    const hit = resolveJedecPair(a.padStart(2, '0'), b.padStart(2, '0'));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Resolve a 4-hex code through the map: the two direct packings first
 * (both carry the stored code byte), then the bounded pair resolution
 * (the parity-fixed lookups on the code half in both positions).
 * undefined when nothing matches - the caller passes the input through.
 * @param {string} hex4 4 uppercase hex digits
 * @returns {string | undefined}
 */
function resolveFourHexCode(hex4) {
  const upper = hex4.toUpperCase();
  const direct = JEDEC_BRAND[upper] ?? JEDEC_BRAND[upper.slice(2) + upper.slice(0, 2)];
  if (direct !== undefined) return direct;
  return resolveJedecPair(upper.slice(0, 2), upper.slice(2, 4));
}

/**
 * Decode a CIM manufacturer value: a JEDEC code maps to the brand;
 * anything else (a real brand name, an empty value, a longer string)
 * passes through unchanged - never a wrong claim.
 *
 * M15: accepts an optional case-insensitive '0x' prefix and 4-8 hex
 * digits (uppercase lookup). A 4-hex code [X][Y] is tried in order 'XY',
 * 'YX', 'X(Y')', '(Y')X' - where Y' is the parity-normalized code byte
 * (jedecCode8) - so the DDR3 parity-carrying rendering and the
 * DDR4/DDR5 raw rendering both resolve (e.g. '004E' resolves via '00CE'
 * to Samsung). 5-8 hex digits are exact-match only; everything unknown
 * passes through unchanged.
 * M17b: the 4-hex FAST PATH also gains the parity-fixed lookups on the
 * FIRST byte (X'Y / YX' - jedecCode8 applied to the CODE half in both
 * positions, fixing the y-only asymmetry), so a code-first raw rendering
 * like 7D0A (bank-10 code 0x7D) resolves via the x-side parity; a
 * 5-digit value drops ONE leading zero (00875 -> 0875) and re-runs the
 * 4-hex logic; other 3-hex shapes run the bounded candidate search
 * (every [count][code] / [code][count] split, 1-2 digits per half
 * zero-padded, parity on the code half in both positions). Unknowns pass
 * through unchanged.
 * @param {unknown} manufacturer
 * @returns {string | null}
 */
export function jedecBrand(manufacturer) {
  if (typeof manufacturer !== 'string' || manufacturer.length === 0) return null;
  const trimmed = manufacturer.trim();
  const stripped = trimmed.replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{4}$/.test(stripped)) {
    return resolveFourHexCode(stripped) ?? trimmed;
  }
  if (/^[0-9A-Fa-f]{5}$/.test(stripped)) {
    // M17b (N2): a 5-digit value like 00875 - drop ONE leading zero and
    // re-run the 4-hex logic (the split rule cannot cover 5 digits as two
    // 1-2-digit halves). Non-zero-leading 5-digit values have no valid
    // split either - they fall through to the exact-match passthrough.
    if (stripped.startsWith('0')) {
      const resolved = resolveFourHexCode(stripped.slice(1));
      if (resolved !== undefined) return resolved;
    }
    return JEDEC_BRAND[stripped.toUpperCase()] ?? trimmed;
  }
  if (/^[0-9A-Fa-f]{3}$/.test(stripped)) {
    // M17b: the bounded candidate search - 875 resolves via [8][75] ->
    // count 08, code 75 -> '0875' -> Juhor.
    const resolved = searchJedecCandidates(stripped);
    if (resolved !== undefined) return resolved;
    return trimmed;
  }
  if (/^[0-9A-Fa-f]{5,8}$/.test(stripped)) {
    return JEDEC_BRAND[stripped.toUpperCase()] ?? trimmed;
  }
  return trimmed;
}

// M17b: the literal SMBIOS "no brand" strings some BIOSes write into the
// Type-17 Manufacturer string (the JEDEC decode table predates the module
// and the board writes a plain word instead of a hex code) - case-
// insensitive. ramBrandOf treats these as "nothing usable" and falls back
// to the part-number heuristic.
const SMBIOS_UNKNOWN_BRANDS = new Set(['unknown', 'not specified', 'standard']);

/**
 * M17b: the RAM-brand resolver with the part-number fallback. When
 * jedecBrand yields nothing usable (null / empty / the literal SMBIOS
 * unknowns 'unknown' / 'not specified' / 'standard', case-insensitive), a
 * part-number match on /juhor|^jhd/i resolves 'Juhor' (the documented
 * heuristic: the Juhor part numbers read 'JUHOR DDR4-3200 16GB', 'JHD...'
 * - the pre-JEP106-programmed modules whose BIOS decode table predates
 * the bank-8 code). NEVER applied when the JEDEC decode succeeded - a
 * decoded brand always wins (never overridden by the part number). Pure.
 * @param {unknown} manufacturer the raw CIM Manufacturer (SPD JEDEC code)
 * @param {unknown} partNumber the raw CIM PartNumber
 * @returns {string | null}
 */
export function ramBrandOf(manufacturer, partNumber) {
  const decoded = jedecBrand(manufacturer);
  const usable = typeof decoded === 'string'
    && decoded.length > 0
    && !SMBIOS_UNKNOWN_BRANDS.has(decoded.trim().toLowerCase());
  if (usable) return decoded;
  const pn = typeof partNumber === 'string' ? partNumber : '';
  return /juhor|^jhd/i.test(pn) ? 'Juhor' : decoded;
}

/**
 * Return the canonical four-digit PCI vendor/device pair from a PNP id or
 * backend field.  PNP is the durable Windows identity; the numeric fields are
 * the fallback exposed by IGCL.  A missing pair is never treated as a match.
 */
function pciPairOf(value) {
  const pnp = typeof value?.pnpDeviceId === 'string' ? value.pnpDeviceId : '';
  const vendor = pnp.match(/(?:^|\\|&)VEN_([0-9A-F]{4})/i)?.[1]
    ?? String(value?.pciVendorId ?? '').replace(/^0x/i, '').slice(-4);
  const device = pnp.match(/(?:^|\\|&)DEV_([0-9A-F]{4})/i)?.[1]
    ?? String(value?.pciDeviceId ?? '').replace(/^0x/i, '').slice(-4);
  return /^[0-9A-F]{4}$/i.test(vendor) && /^[0-9A-F]{4}$/i.test(device)
    ? { vendor: vendor.toLowerCase(), device: device.toLowerCase() }
    : null;
}

function samePciPair(left, right) {
  const a = pciPairOf(left);
  const b = pciPairOf(right);
  return Boolean(a && b && a.vendor === b.vendor && a.device === b.device);
}

function explicitPciPairOf(value) {
  const vendor = String(value?.pciVendorId ?? value?.osController?.pciVendorId ?? '').replace(/^0x/i, '').slice(-4);
  const device = String(value?.pciDeviceId ?? value?.osController?.pciDeviceId ?? '').replace(/^0x/i, '').slice(-4);
  return /^[0-9A-F]{4}$/i.test(vendor) && /^[0-9A-F]{4}$/i.test(device)
    ? { vendor: vendor.toLowerCase(), device: device.toLowerCase() }
    : null;
}

function pciPairFromPnp(value) {
  const pnp = normalizeIdentity(value);
  const vendor = pnp?.match(/(?:^|\\|&)VEN_([0-9A-F]{4})/i)?.[1];
  const device = pnp?.match(/(?:^|\\|&)DEV_([0-9A-F]{4})/i)?.[1];
  return vendor && device ? { vendor: vendor.toLowerCase(), device: device.toLowerCase() } : null;
}

function equalPciPair(left, right) {
  return Boolean(left && right && left.vendor === right.vendor && left.device === right.device);
}

function stableIdentityParts(value) {
  const pnpValues = [value?.pnpDeviceId, value?.osController?.pnpDeviceId]
    .map(normalizeIdentity)
    .filter((v) => v !== null);
  const bdfValues = [
    value?.bdf,
    value?.locationInfo,
    value?.osController?.bdf,
    value?.osController?.locationInfo,
  ].map(bdfOf).filter((v) => v !== null);
  const explicitPci = [explicitPciPairOf(value), explicitPciPairOf(value?.osController)]
    .filter((v) => v !== null);
  const pnpPci = pnpValues.map(pciPairFromPnp).filter((v) => v !== null);
  const pciValues = [...explicitPci, ...pnpPci];
  const pnp = pnpValues[0] ?? null;
  const bdf = bdfValues[0] ?? null;
  const pci = pciValues[0] ?? null;
  return {
    pnp,
    bdf,
    pci,
    invalid: new Set(pnpValues).size > 1
      || new Set(bdfValues).size > 1
      || pciValues.some((pair) => !equalPciPair(pair, pci)),
  };
}

function stableIdentitiesAgree(device, controller) {
  const left = stableIdentityParts(device);
  const right = stableIdentityParts(controller);
  if (left.invalid || right.invalid) return false;
  if (left.pnp && right.pnp && left.pnp !== right.pnp) return false;
  if (left.bdf && right.bdf && left.bdf !== right.bdf) return false;
  if (left.pci && right.pci && !equalPciPair(left.pci, right.pci)) return false;
  return true;
}

function stableIdentityEvidenceMatches(deviceParts, controllerParts) {
  return (deviceParts.pnp && controllerParts.pnp && deviceParts.pnp === controllerParts.pnp)
    || (deviceParts.bdf && controllerParts.bdf && deviceParts.bdf === controllerParts.bdf)
    || (deviceParts.pci && controllerParts.pci && equalPciPair(deviceParts.pci, controllerParts.pci));
}

function rebarTargetOf(target) {
  if (target && Array.isArray(target.videoControllers)) {
    const identified = target.videoControllers.filter((controller) => pciPairOf(controller));
    return identified.length === 1 ? identified[0] : null;
  }
  return target && typeof target === 'object' ? target : null;
}

/**
 * M4-D2 ("read the driver's BAR state"): merge the driver's verdict onto the
 * controller that supplied the matching PCI/PNP identity.  The optional
 * target is the identity selected by the raw IGCL reader; with no target the
 * historical single-controller behavior remains for electron-free callers.
 * An identity mismatch or collision is fail-closed and leaves the OS payload
 * untouched.
 * @param {object} sysinfo the cached sysinfo shape
 * @param {boolean|null} driverEnabled the driver's resizable_bar_enabled
 * @param {object|null} target raw backend identity selected for the verdict
 * @returns {object} a NEW sysinfo object with the driver verdict merged
 */
export function applyDriverReBar(sysinfo, driverEnabled, target = null) {
  if (driverEnabled === null || driverEnabled === undefined || typeof sysinfo !== 'object' || sysinfo === null) {
    return sysinfo;
  }
  if (!Array.isArray(sysinfo.videoControllers) || sysinfo.videoControllers.length === 0) {
    return sysinfo;
  }
  const controllers = sysinfo.videoControllers;
  let index = 0;
  const wanted = rebarTargetOf(target);
  if (Array.isArray(target?.videoControllers) && !wanted) return sysinfo;
  if (wanted) {
    const exactPnp = typeof wanted.pnpDeviceId === 'string'
      ? controllers.map((controller, i) => ({ controller, i }))
        .filter(({ controller }) => typeof controller?.pnpDeviceId === 'string'
          && controller.pnpDeviceId.trim().toUpperCase() === wanted.pnpDeviceId.trim().toUpperCase())
      : [];
    const pairMatches = controllers.map((controller, i) => ({ controller, i }))
      .filter(({ controller }) => samePciPair(controller, wanted));
    const matches = exactPnp.length > 0 ? exactPnp : pairMatches;
    if (matches.length !== 1) return sysinfo;
    index = matches[0].i;
  }
  return {
    ...sysinfo,
    videoControllers: controllers.map((controller, i) => (
      i === index ? { ...controller, rebarActive: driverEnabled } : controller
    )),
  };
}

/**
 * @param {{ listDevices: () => Promise<Array<object>>, pciProperties: (id: unknown) => Promise<object|null> }} backend
 * @param {object|null} target sysinfo payload or controller identity
 * @returns {(() => Promise<boolean|null>) & { target?: object|null, setTarget?: (value: object|null) => void }}
 */
export function createDriverReBar(backend, target = null) {
  let promise = null;
  let selectedTarget = null;
  let requestedTarget = target;
  const read = () => {
    if (!promise) {
      promise = (async () => {
        try {
          const devices = await backend.listDevices();
          let candidates = devices;
          const wanted = rebarTargetOf(requestedTarget);
          const fullCim = Array.isArray(requestedTarget?.videoControllers)
            && (Object.prototype.hasOwnProperty.call(requestedTarget, 'cpu')
              || Object.prototype.hasOwnProperty.call(requestedTarget, 'ram')
              || Object.prototype.hasOwnProperty.call(requestedTarget, 'baseboard')
              || Object.prototype.hasOwnProperty.call(requestedTarget, 'laptop'));
          if (fullCim) {
            // A full CIM snapshot is an inventory, not permission to retarget
            // to whichever identity happens to appear in that inventory.
            // listDevices() is discrete-first on the raw backend; require
            // that selected handle to carry one unique identity. A
            // property-less first handle therefore fails closed instead of
            // querying a later adapter.
            const selected = devices[0];
            const selectedPair = pciPairOf(selected);
            if (!selectedPair) return null;
            const targetMatches = requestedTarget.videoControllers.filter((controller) => samePciPair(controller, selected));
            const rawMatches = devices.filter((device) => samePciPair(device, selected));
            if (targetMatches.length !== 1 || rawMatches.length !== 1) return null;
            candidates = rawMatches;
          } else if (wanted && pciPairOf(wanted)) {
            candidates = devices.filter((device) => samePciPair(device, wanted));
            if (candidates.length !== 1) return null;
          } else if (Array.isArray(requestedTarget?.videoControllers)) {
            const controllerPairs = requestedTarget.videoControllers.filter((controller) => pciPairOf(controller));
            candidates = devices.filter((device) => controllerPairs.some((controller) => samePciPair(device, controller)));
            if (candidates.length === 0) return null;
            const firstPair = pciPairOf(candidates[0]);
            if (firstPair && candidates.filter((device) => samePciPair(device, candidates[0])).length !== 1) return null;
          } else if (!wanted) {
            // Prefer identity-bearing rows over property-less handles. More
            // than one identity-bearing row is ambiguous without a target.
            const identified = devices.filter((device) => pciPairOf(device));
            if (identified.length === 1) candidates = identified;
            else if (identified.length > 1) return null;
          } else {
            return null;
          }
          const selected = candidates[0];
          const p = await backend.pciProperties(selected.id);
          if (!p || typeof p.resizableBarEnabled !== 'boolean') return null;
          selectedTarget = selected;
          return p.resizableBarEnabled;
        } catch {
          return null;
        }
      })();
    }
    return promise;
  };
  read.setTarget = (value) => {
    if (promise === null) requestedTarget = value;
  };
  Object.defineProperty(read, 'target', { enumerable: true, get: () => selectedTarget });
  return read;
}

/**
 * M4-D: the ReBAR verdict - a functioning Resizable BAR shows a
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
 * controller list - per controller, the ReBAR verdict comes from the LARGER
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
 * missing/unparseable piece degrades per-field (null / empty array) - the
 * query result is a best-effort read, never a boot blocker.
 * M17c: the payload gains the `laptop` field (the laptop-branch AIB source):
 * Win32_ComputerSystem Manufacturer/Model/PCSystemType + Win32_SystemEnclosure
 * ChassisTypes - consumed lazily ONCE by the backend's caps decode (the
 * portable-form-factor rule lives in pure/aib.ts).
 * @param {string} stdout
 * @returns {{ cpu: object, ram: object, baseboard: object, videoControllers: object[], laptop: object }}
 */
export function parseCimOutput(stdout) {
  let raw = null;
  try {
    raw = JSON.parse(String(stdout ?? ''));
  } catch {
    // Garbage output (UAC prompt interleaved, PS 2 vs 5 quirks) degrades to
    // the fallback shape's empties - the caller decides whether to fall back.
    return { cpu: {}, ram: {}, baseboard: {}, videoControllers: [], laptop: { manufacturer: null, model: null, pcSystemType: null, chassisTypes: [] } };
  }
  const cpuRaw = raw && typeof raw === 'object' ? raw.cpu : null;
  const csRaw = raw && typeof raw === 'object' ? raw.computerSystem : null;
  const encRaw = raw && typeof raw === 'object' ? raw.systemEnclosure : null;
  const memRaw = raw && typeof raw === 'object' ? raw.physicalMemory : null;
  const bbRaw = raw && typeof raw === 'object' ? raw.baseboard : null;
  const vgaRaw = Array.isArray(raw?.videoControllers) ? raw.videoControllers : [];

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const cpu = {
    name: typeof cpuRaw?.Name === 'string' && cpuRaw.Name ? cpuRaw.Name : null,
    cores: num(cpuRaw?.NumberOfCores),
    threads: num(cpuRaw?.NumberOfLogicalProcessors),
    maxClockMhz: num(cpuRaw?.MaxClockSpeed),
    // M15 (F2): Win32_Processor.Manufacturer - the AMD-vs-not gate for the
    // MSR reader's module selection (isAmdVendor in msr-reader.js: a
    // case-insensitive match on /amd/ or the SMBIOS phrase 'advanced micro
    // devices' - 'AuthenticAMD', 'Advanced Micro Devices, Inc.', ...). The
    // gate is the MANUFACTURER string, NOT Win32_Processor.Family - the
    // DMTF SMBIOS family table defines no AMD Zen values for real machines
    // (see the S1 deviation record in the M15 report), so a family-range
    // gate provably never activated on Zen and misloaded the AMD module on
    // Intel machines reporting its boundary values. The AMDFamily17.bin
    // module ITSELF re-checks the CPUID vendor + Zen family range (a
    // non-Zen AMD part self-refuses with STATUS_NOT_SUPPORTED -> the
    // honest null degrade).
    manufacturer: typeof cpuRaw?.Manufacturer === 'string' && cpuRaw.Manufacturer ? cpuRaw.Manufacturer : null,
  };
  // M4J (B): the baseboard row (Mainboard) - the RAW Manufacturer/Product
  // strings; the renderer's mainboardRow applies the manufacturer short-map
  // (display concern, renderer-side).
  const baseboard = {
    manufacturer: typeof bbRaw?.Manufacturer === 'string' && bbRaw.Manufacturer ? bbRaw.Manufacturer : null,
    product: typeof bbRaw?.Product === 'string' && bbRaw.Product ? bbRaw.Product : null,
  };
  const ram = {
    totalBytes: num(csRaw?.TotalPhysicalMemory) ?? 0,
    speedMhz: num(memRaw?.ConfiguredClockSpeed),
    // M4-D2: the raw SPD JEDEC code ("0420") decodes to the brand
    // (G.Skill); a real name / unknown code passes through honestly.
    // M17b: the part-number fallback (ramBrandOf) - a literal SMBIOS
    // 'Unknown' manufacturer with a Juhor part number resolves 'Juhor'
    // (the BIOS decode table predates the Juhor bank-8 code); a decoded
    // brand always wins.
    manufacturer: ramBrandOf(memRaw?.Manufacturer, memRaw?.PartNumber),
    // M4-H: the SMBIOS Type-17 memory-type code (24=DDR3, 34=DDR5, ... -
    // the pure ramMemoryType mapping in the renderer derives the label).
    memoryType: num(memRaw?.SMBIOSMemoryType),
  };
  // M17c: the laptop-branch fields - Win32_ComputerSystem Manufacturer /
  // Model / PCSystemType + Win32_SystemEnclosure ChassisTypes. Missing
  // classes degrade per-field (null / []) - a desktop's systemEnclosure
  // row may be absent on stripped systems; the backend's laptopAibOf then
  // sees a non-portable shape and the subsystem decode stays authoritative.
  const chassisRaw = Array.isArray(encRaw?.ChassisTypes) ? encRaw.ChassisTypes : [];
  const laptop = {
    manufacturer: typeof csRaw?.Manufacturer === 'string' && csRaw.Manufacturer ? csRaw.Manufacturer : null,
    model: typeof csRaw?.Model === 'string' && csRaw.Model ? csRaw.Model : null,
    pcSystemType: typeof csRaw?.PCSystemType === 'number' && Number.isFinite(csRaw.PCSystemType) ? csRaw.PCSystemType : null,
    chassisTypes: chassisRaw.filter((t) => typeof t === 'number' && Number.isFinite(t)).map((t) => Math.floor(t)),
  };
  const controllers = applyAllocatedBar(
    applyRegistryMemory(
      vgaRaw
        .map((c) => ({
          name: typeof c?.Name === 'string' ? c.Name : null,
          vramBytes: vramBytesFromAdapterRam(c?.AdapterRAM),
          pnpDeviceId: typeof c?.PNPDeviceID === 'string' && c.PNPDeviceID ? c.PNPDeviceID : null,
          // M4-I: the controller's display-driver version (works on ANY
          // GPU - the no-Intel device card's Driver version row source).
          driverVersion: typeof c?.DriverVersion === 'string' && c.DriverVersion ? c.DriverVersion : null,
          // Windows reports a current mode for a controller with an active
          // display path. This is a preference signal only; an older cached
          // payload without these fields keeps the historical shape.
          ...((c?.CurrentHorizontalResolution !== undefined || c?.CurrentVerticalResolution !== undefined)
            ? { displayActive: Number.isFinite(Number(c?.CurrentHorizontalResolution))
              && Number(c.CurrentHorizontalResolution) > 0
              && Number.isFinite(Number(c?.CurrentVerticalResolution))
              && Number(c.CurrentVerticalResolution) > 0 }
            : {}),
          rebarActive: null,
          ...(typeof c?.LocationInfo === 'string' && c.LocationInfo ? { locationInfo: c.LocationInfo } : {}),
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
  // verdict does). M7b (fix 1): the payload then filters through
  // isRealGpuController - only AMD/Intel/NVIDIA parts survive (a
  // "Microsoft Basic Display Adapter" / DisplayLink controller must never
  // win the dashboard/health videoControllers[0] fallbacks).
  const videoControllers = controllers
    .map(({ _pnputilBarBytes, ...rest }) => rest)
    .filter(isRealGpuController);
  return { cpu, ram, baseboard, laptop, videoControllers };
}

/**
 * M4-D: the honest os.cpus()/os.totalmem() fallback shape - RAM
 * speed + video controllers degrade to null/empty (there is no OS-level
 * source for them), and `cores` degrades to null because os.cpus() cannot
 * distinguish physical from logical cores (never an estimate).
 * @returns {{ cpu: object, ram: object, videoControllers: [] }}
 */
export function fallbackSysinfo() {
  const cpus = os.cpus();
  const cpu = cpus.length > 0
    ? { name: cpus[0].model, cores: null, threads: cpus.length, maxClockMhz: cpus[0].speed, manufacturer: null }
    : { name: null, cores: null, threads: null, maxClockMhz: null, manufacturer: null };
  return {
    cpu,
    ram: { totalBytes: os.totalmem(), speedMhz: null, manufacturer: null, memoryType: null },
    baseboard: { manufacturer: null, product: null },
    // M17c: the os.cpus() fallback has no laptop source - the honest
    // non-portable shape (the backend's laptopAibOf returns null and the
    // subsystem decode stays authoritative).
    laptop: { manufacturer: null, model: null, pcSystemType: null, chassisTypes: [] },
    videoControllers: [],
  };
}

/**
 * Run the CIM query ONCE per session (module-level cache) with the
 * injectable execFile (tests pass a fake; the product path never runs
 * PowerShell in mock mode - main.js injects createMockSysinfo() there).
 * Any query failure (PowerShell absent, spawn error, timeout, garbage
 * output) falls back to os.cpus()/os.totalmem() - never throws. The query
 * timeout is SHORT (10 s - M4-D review F3): a hung PowerShell must not
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
      // No usable CPU row (garbage output, PS 2 quirks, empty classes) -
      // the honest os.cpus() fallback, same as a PowerShell failure.
      cached = fallbackSysinfo();
    } else {
      cached = {
        cpu: {
          name: parsed.cpu.name,
          cores: parsed.cpu.cores,
          threads: parsed.cpu.threads,
          maxClockMhz: parsed.cpu.maxClockMhz,
          // M15 (F2): the manufacturer MUST ride the cached shape too (the
          // collectSysinfo rebuild dropped it in the first plan draft - the
          // reader's cached?.cpu?.manufacturer would then be undefined
          // forever, exactly like the pre-correction family).
          manufacturer: parsed.cpu.manufacturer,
        },
        ram: {
          totalBytes: parsed.ram?.totalBytes || os.totalmem(),
          speedMhz: parsed.ram?.speedMhz ?? null,
          manufacturer: parsed.ram?.manufacturer ?? null,
          memoryType: parsed.ram?.memoryType ?? null,
        },
        // M4J (B): the baseboard (Mainboard row) rides the payload.
        baseboard: {
          manufacturer: parsed.baseboard?.manufacturer ?? null,
          product: parsed.baseboard?.product ?? null,
        },
        // M17c: the laptop fields ride the cached payload (the backend's
        // caps decode consumes them lazily ONCE - the laptopInfoOf provider
        // reads this cache, the vramBytesOf pattern).
        laptop: {
          manufacturer: parsed.laptop?.manufacturer ?? null,
          model: parsed.laptop?.model ?? null,
          pcSystemType: parsed.laptop?.pcSystemType ?? null,
          chassisTypes: Array.isArray(parsed.laptop?.chassisTypes) ? parsed.laptop.chassisTypes : [],
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
 * Reset the session cache (tests only - each test pins its own fallback).
 */
export function resetSysinfoCache() {
  cached = null;
}

// ---------------------------------------------------------------------------
// VRAM enrichment (M4-D user addition) - matching a backend adapter against
// the CIM video-controller list by stable physical identity first, with a
// unique name fallback for older provider payloads.
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
 *   1. exact normalized name equality (the common case - both sources name
 *      the card the same way);
 *   2. GPU-family token match - a shared family token (e.g. 'arc') PLUS at
 *      least one shared non-family model token (e.g. 'a770'). A bare family
 *      token never satisfies this path: 'Intel(R) Arc(TM) Graphics' (no
 *      model token) and 'Intel Arc A750' against an A770 row must NOT claim
 *      the A770's VRAM - a wrong cross-card match prints a WRONG number,
 *      worse than an honest null (M4-D review F1);
 *   3. the primary non-basic adapter - ONLY for model-less device names
 *      (every token is generic/family, e.g. 'Intel(R) Arc(TM) Graphics'):
 *      the first controller that is not a basic-display/Microsoft fallback
 *      adapter (the dGPU is normally listed first). A name that names a
 *      SPECIFIC model (e.g. 'A750') which matched no controller degrades
 *      honestly to null - the fallback must never attach a different
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
  const exact = list.filter((c) => c.name && normalize(c.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // 2. GPU-family token match: the family token is NOT enough - a shared
  // NON-family token (a real model token like 'a770') is required too.
  const targetTokens = tokensOf(deviceName);
  const familyMatches = [];
  for (const c of list) {
    if (!c.name) continue;
    const cTokens = tokensOf(c.name);
    const shared = [...targetTokens].filter((t) => cTokens.has(t) && !GENERIC_TOKENS.has(t));
    const familyShared = [...targetTokens].filter((t) => cTokens.has(t) && GPU_FAMILY_TOKENS.has(t));
    const modelShared = shared.filter((t) => !GPU_FAMILY_TOKENS.has(t));
    if (familyShared.length > 0 && modelShared.length >= 1) familyMatches.push(c);
  }
  if (familyMatches.length === 1) return familyMatches[0];
  if (familyMatches.length > 1) return null;

  // 3. primary non-basic adapter - only for a MODEL-LESS device name (all
  // tokens generic/family). A name carrying a model token that matched no
  // controller is an unmatched specific card -> honest null, never a wrong
  // cross-model VRAM claim.
  const hasModelToken = [...targetTokens]
    .some((t) => !GENERIC_TOKENS.has(t) && !GPU_FAMILY_TOKENS.has(t));
  if (!hasModelToken) {
    const primary = list.filter((c) => c.name && !/basic|microsoft/i.test(c.name));
    if (primary.length === 1) return primary[0];
  }
  return null;
}

function normalizeIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().replace(/[\u0000\s]+/g, '').toUpperCase()
    : null;
}

function bdfOf(value) {
  if (typeof value === 'string') {
    const direct = value.trim().match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (direct) {
      return `${Number.parseInt(direct[1] ?? '0', 16).toString(16).padStart(4, '0')}:${Number.parseInt(direct[2], 16).toString(16).padStart(2, '0')}:${Number.parseInt(direct[3], 16).toString(16).padStart(2, '0')}.${direct[4]}`;
    }
    const location = value.match(/\bbus\s*(\d+)\s*,?\s*device\s*(\d+)\s*,?\s*function\s*(\d+)/i);
    if (location) return `0000:${Number(location[1]).toString(16).padStart(2, '0')}:${Number(location[2]).toString(16).padStart(2, '0')}.${location[3]}`;
  }
  if (value && typeof value === 'object') {
    const bus = Number(value.bus);
    const device = Number(value.device);
    const fn = Number(value.function ?? value.func ?? 0);
    const domain = Number(value.domain ?? value.segment ?? 0);
    if ([bus, device, fn, domain].every(Number.isInteger) && bus >= 0 && device >= 0 && fn >= 0 && domain >= 0) {
      return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
    }
  }
  return null;
}

function stableControllerMatch(device, controllers) {
  const target = stableIdentityParts(device);
  const hasStableIdentity = Boolean(target.pnp || target.bdf || target.pci);
  if (!hasStableIdentity || target.invalid) return { matched: hasStableIdentity, controller: null };

  const byPnp = target.pnp ? controllers.filter((c) => stableIdentityParts(c).pnp === target.pnp) : [];
  // A PNP group is authoritative when present. Secondary identities can
  // disambiguate a duplicate group, but every supplied identity must agree
  // before a candidate is allowed through.
  if (byPnp.length > 0) {
    const consistent = byPnp.filter((c) => stableIdentitiesAgree(device, c));
    if (consistent.length === 1 && byPnp.length === 1) return { matched: true, controller: consistent[0] };
    const byBdf = target.bdf ? consistent.filter((c) => stableIdentityParts(c).bdf === target.bdf) : [];
    if (byBdf.length === 1) return { matched: true, controller: byBdf[0] };
    const byPci = target.pci ? consistent.filter((c) => equalPciPair(stableIdentityParts(c).pci, target.pci)) : [];
    if (byPci.length === 1) return { matched: true, controller: byPci[0] };
    return { matched: true, controller: null };
  }

  // A controller without PNP may still be joined by a unique BDF/PCI proof.
  // A controller carrying a different PNP is rejected by the same predicate.
  const candidates = controllers.filter((c) => {
    const parts = stableIdentityParts(c);
    return stableIdentitiesAgree(device, c) && stableIdentityEvidenceMatches(target, parts);
  });
  const byBdf = target.bdf ? candidates.filter((c) => stableIdentityParts(c).bdf === target.bdf) : [];
  if (byBdf.length === 1) return { matched: true, controller: byBdf[0] };
  const byPci = target.pci ? candidates.filter((c) => equalPciPair(stableIdentityParts(c).pci, target.pci)) : [];
  if (byPci.length === 1) return { matched: true, controller: byPci[0] };
  // Once the device carries any stable identity, a failed or conflicting
  // join is authoritative.  Falling through to a similar-looking name can
  // assign another GPU's VRAM to this device.
  return { matched: hasStableIdentity, controller: null };
}

/**
 * The vramBytesOf provider wired into IgclBackend (main.js real path):
 * match the device against the cached sysinfo and return its vramBytes
 * (null when unmatched/degraded - formatDeviceName then keeps the plain
 * name).
 * @param {{ name?: string, pnpDeviceId?: string|null, pciVendorId?: string|null, pciDeviceId?: string|null, bdf?: object|string, osController?: object|null }} device
 * @param {{ videoControllers?: Array<{ name: string|null, vramBytes: number|null, pnpDeviceId: string|null, locationInfo?: string|null }> } | null} sysinfo
 * @returns {number | null}
 */
export function vramBytesOfDevice(device, sysinfo) {
  const controllers = Array.isArray(sysinfo?.videoControllers) ? sysinfo.videoControllers : [];
  if (controllers.length === 0) return null;
  const stable = stableControllerMatch(device, controllers);
  if (stable.matched) {
    return stable.controller && Number.isInteger(stable.controller.vramBytes) && stable.controller.vramBytes > 0
      ? stable.controller.vramBytes
      : null;
  }
  const match = matchVideoController(device?.name ?? '', controllers);
  return match && Number.isInteger(match.vramBytes) && match.vramBytes > 0 ? match.vramBytes : null;
}

/**
 * In-memory fixture - the default sysinfo adapter for tests and --ui-verify
 * (never spawns PowerShell). Fixed values so the dashboard CPU card and the
 * sysinfo IPC payload are deterministic in mock mode.
 * 1.0.1 no-Intel round: RID_MOCK_NO_INTEL=1 switches the fixture's video
 * controller to an AMD part ('AMD Radeon RX 7600'-style with vramBytes + a
 * pnpDeviceId + rebarActive false) - the no-Intel machine shape the
 * renderer's osGpu / header / GPU card read.
 * M17d (Run B): the no-Intel REAL controller is overridable via
 * `overrides.noIntelController` - the ui-verify no-intel+nvml variant
 * (RID_MOCK_NO_INTEL=1 + RID_MOCK_VENDOR=nvml) swaps in the GTX 980-class
 * NVIDIA shape (SUBSYS_36811458 -> the 'Gigabyte' Board-partner decode, the
 * 4 GiB OS-VRAM source, the resolved ReBAR verdict); the Basic/DisplayLink
 * rows stay so the M7b filter pin keeps its meaning.
 * M7b (fix 1): the no-Intel fixture ALSO carries a 'Microsoft Basic Display
 * Adapter' FIRST + a DisplayLink dock (the non-GPU devices that leak into
 * Win32_VideoController) - the fixture path bypasses the parse, so the
 * controller list is filtered through isRealGpuController HERE; only the
 * AMD part survives, proving a non-GPU first controller never wins the GPU
 * card / health row / header name.
 * M30: RID_MOCK_ZERO_GPU=1 explicitly removes even the synthetic OS
 * controller, preserving the true empty-inventory verification; NO_INTEL
 * alone keeps the AMD OS-only controller row.
 * M4-H: the fixture gains SMBIOSMemoryType 34 (DDR5 - the Memory-row type
 * label). M4J (B): the fixture drops the l1-l4 cache fields (the Cache row
 * is REMOVED) and gains the baseboard (the Mainboard row - the ASUSTeK-style
 * value the pins assert).
 * M17c: the fixture gains the `laptop` field (the laptop-branch AIB source -
 * the desktop shape by default: pcSystemType 3 + a tower chassis, so the
 * mock's caps AIB decode stays on the subsystem fields; the laptop ui-verify
 * fixture overrides it via `overrides.laptop`).
 * @param {{ cpu?: object, ram?: object, videoControllers?: object[], laptop?: object }} [overrides]
 */
export function createMockSysinfo(overrides = {}) {
  const noIntel = process.env.RID_MOCK_NO_INTEL === '1';
  const zeroGpu = process.env.RID_MOCK_ZERO_GPU === '1';
  const duplicatePnpOverlay = process.env.RID_MOCK_DUPLICATE_PNP_OVERLAY === '1';
  // M17d (Run B): the no-Intel REAL-controller override - the ui-verify
  // no-intel+nvml variant (RID_MOCK_NO_INTEL=1 + RID_MOCK_VENDOR=nvml)
  // replaces the default AMD row with the GTX 980-class shape (the
  // NVIDIA controller whose SUBSYS_36811458 decodes Gigabyte + whose
  // vramBytes/rebarActive simulate the resolved OS sources); the
  // Basic/DisplayLink rows stay so the M7b filter pin keeps its meaning.
  const noIntelReal = overrides.noIntelController ?? {
    name: 'AMD Radeon RX 7600',
    vramBytes: 8589934592, // 8 GiB
    pnpDeviceId: 'PCI\\VEN_1002&DEV_7480&SUBSYS_24011462&REV_C7',
    // M4-I: the controller's display-driver version (the no-Intel
    // device card's Driver version row - works on ANY GPU).
    driverVersion: '31.0.12027.9001',
    rebarActive: false,
  };
  // M7b (fix 1): the fixture's controller list is filtered through
  // isRealGpuController like the parse filters the CIM payload - the mock
  // path bypasses the parse, so the filter must run HERE (the default +
  // no-Intel fixtures stay green; a Basic Display Adapter first controller
  // is genuinely filtered).
  const fixtureControllers = zeroGpu ? [] : duplicatePnpOverlay ? [
    {
      name: 'Intel(R) Arc(TM) A770 Graphics',
      vramBytes: 17179869184,
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_DUPLICATE',
      bdf: { bus: 3, device: 0, function: 0 },
      driverVersion: '32.0.101.8861',
      rebarActive: true,
    },
    {
      name: 'Intel(R) Arc(TM) A770 Secondary Graphics',
      vramBytes: 8589934592,
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_DUPLICATE',
      bdf: { bus: 0, device: 2, function: 0 },
      driverVersion: '32.0.101.8861',
      rebarActive: null,
    },
    {
      name: 'Intel(R) Arc(TM) Ambiguous Graphics',
      vramBytes: null,
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_DUPLICATE',
      luid: 'duplicate-pnp-ambiguous-luid',
      driverVersion: '32.0.101.8861',
      rebarActive: null,
    },
  ] : noIntel ? [
    {
      // M7b: the FIRST controller is a non-GPU (the "Microsoft Basic
      // Display Adapter" every Windows box can list) - the predicate must
      // filter it so it never wins the dashboard/health fallbacks.
      name: 'Microsoft Basic Display Adapter',
      vramBytes: null,
      pnpDeviceId: 'ROOT\\BASIC_DISPLAY\\0000',
      driverVersion: '10.0.19041.1',
      rebarActive: null,
    },
    {
      // M7b: a DisplayLink dock - a non-GPU device (VID_17E9) that must
      // never win either.
      name: 'DisplayLink USB Graphics',
      vramBytes: null,
      pnpDeviceId: 'USB\\VID_17E9&PID_0236\\MOCK0001',
      driverVersion: '10.0.19041.1',
      rebarActive: null,
    },
    noIntelReal,
    ...(overrides.videoControllers ?? []),
  ] : [
    {
      name: 'Intel(R) Arc(TM) A770 Graphics',
      vramBytes: 17179869184, // 16 GiB (the 16 GB config)
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08',
      driverVersion: '32.0.101.8861',
      rebarActive: true,
    },
    ...(overrides.videoControllers ?? []),
  ];
  return {
    get: async () => ({
      cpu: {
        name: 'Intel(R) Core(TM) i7-14700K',
        cores: 20,
        threads: 28,
        maxClockMhz: 5600,
        // M15 (F2): the mock fixture keeps `manufacturer: null` (the Intel
        // box - the reader's isAmdVendor(null) = false -> the IntelMSR.bin
        // path).
        manufacturer: null,
        ...(overrides.cpu ?? {}),
      },
      ram: {
        totalBytes: 34359738368, // 32 GiB
        speedMhz: 6000,
        manufacturer: 'G.Skill',
        memoryType: 34, // DDR5 (SMBIOS Type-17)
        ...(overrides.ram ?? {}),
      },
      // M4J (B): the baseboard fixture - the ASUSTeK-style value the
      // Mainboard row pins ("ASUSTeK MAXIMUS VII RANGER" via the short-map).
      baseboard: {
        manufacturer: 'ASUSTeK COMPUTER INC.',
        product: 'MAXIMUS VII RANGER',
        ...(overrides.baseboard ?? {}),
      },
      // M17c: the laptop fields - the DESKTOP shape by default (pcSystemType
      // 3 + a tower chassis 7: NOT portable - the caps AIB decode stays on
      // the subsystem fields); the laptop ui-verify fixture overrides it
      // ('Micro-Star International Co., Ltd.' + a portable chassis -> the
      // 'MSI (<model>)' Dashboard entry).
      laptop: {
        manufacturer: 'ASUSTeK COMPUTER INC.',
        model: 'MAXIMUS VII RANGER',
        pcSystemType: 3,
        chassisTypes: [7],
        ...(overrides.laptop ?? {}),
      },
      videoControllers: fixtureControllers.filter(isRealGpuController),
    }),
  };
}
